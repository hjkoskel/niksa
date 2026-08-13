(() => {
  "use strict";

  const $ = id => document.getElementById(id);
  const state = {
    mode: null, pc: null, dc: null, stream: null, serial: null, streams: [], cameraResults: [], cameraErrors: [],
    ctrl: { armed:false, light:false, throttle:0, steer:0 }, txTimer: null, rxParser: null
  };
  const ICE = [{urls:"stun:stun.l.google.com:19302"}];

  // Keep WebRTC negotiation small: without this, every negotiated video
  // m-line repeats a full codec/RTCP/header-extension block, which adds up
  // fast with several camera transceivers on one PeerConnection. Must be
  // set via RTCRtpTransceiver.setCodecPreferences(), not RTCRtpSender —
  // use addTransceiver() so it applies consistently to every camera.
  function compactVideoCodecs() {
    // getCapabilities() includes RTX/FEC and every H.264 profile the
    // browser supports; keep only one VP8 entry and one H.264 entry.
    const caps = RTCRtpSender.getCapabilities?.("video")?.codecs || [];
    const primary = caps.filter(c => {
      const mime = (c.mimeType || "").toLowerCase();
      return mime === "video/vp8" || mime === "video/h264";
    });

    const out = [];
    const vp8 = primary.find(c => (c.mimeType || "").toLowerCase() === "video/vp8");
    if (vp8) out.push(vp8);

    // Prefer packetization-mode=1 with a constrained-baseline/baseline profile.
    const h264Candidates = primary.filter(c =>
      (c.mimeType || "").toLowerCase() === "video/h264" &&
      /packetization-mode=1/i.test(c.sdpFmtpLine || "")
    );
    const h264 = h264Candidates.find(c =>
      /profile-level-id=(42e01f|42001f)/i.test(c.sdpFmtpLine || "")
    ) || h264Candidates[0];
    if (h264) out.push(h264);

    return out;
  }

  // This is intentionally only a diagnostic/size helper. We do NOT SDP-munge
  // the offer after createOffer(), because changing payload types or extmaps
  // after the browser generated the offer can make negotiation unreliable.
  function sdpStats(sdp) {
    const text = sdp || "";
    return {
      bytes: new TextEncoder().encode(text).length,
      candidates: (text.match(/^a=candidate:/gm) || []).length,
      videoMlines: (text.match(/^m=video /gm) || []).length,
      payloads: (text.match(/^m=video .*$/gm) || []).map(x => x.trim())
    };
  }

  // --------------------------------------------------------------------
  // CRSF (Crossfire) framing — ported from the Go ugvgo test bench so
  // the byte layout matches exactly what the Pico firmware expects.
  // --------------------------------------------------------------------
  const CRSF_SYNC          = 0xC8;
  const CRSF_GPS           = 0x02;
  const CRSF_BATTERY       = 0x08;
  const CRSF_ACCEL_GYRO    = 0x13;
  const CRSF_RC_CHANNELS   = 0x16;

  // CRC8 DVB-S2, poly 0xD5, matches util.go's crc8().
  function crsfCrc8(bytes) {
    let crc = 0;
    for (let i = 0; i < bytes.length; i++) {
      crc ^= bytes[i];
      for (let b = 0; b < 8; b++) {
        crc = (crc & 0x80) ? ((crc << 1) ^ 0xD5) & 0xFF : (crc << 1) & 0xFF;
      }
    }
    return crc;
  }

  // Generic broadcast-frame builder per spec: length = Type + Payload + CRC.
  // (Unlike the Go lib's buildBatteryFrame, which hardcodes an inconsistent
  // length byte — see chat notes — this follows the spec exactly, so these
  // frames are correctly delimited by CRSFParser on the receiving end.)
  function crsfBuildFrame(type, payload) {
    const frame = new Uint8Array(3 + payload.length + 1);
    frame[0] = CRSF_SYNC;
    frame[1] = 1 + payload.length + 1;
    frame[2] = type;
    frame.set(payload, 3);
    frame[frame.length - 1] = crsfCrc8(frame.subarray(2, frame.length - 1));
    return frame;
  }

  function clampU16(v) { return Math.max(0, Math.min(65535, v)); }
  function clampI16(v) { return Math.max(-32768, Math.min(32767, v)); }

  // Generic big-endian field codec shared by every CRSF payload below.
  // A field is [key, type, scale=1, offset=0, clamp?]. Encoding does
  // round(value*scale)+offset (then clamp); decoding does the inverse.
  // type is one of i32/u32/u16/i16/u8 and fixes both wire width and sign.
  const FIELD_SIZE = { i32: 4, u32: 4, u16: 2, i16: 2, u8: 1 };
  const FIELD_SUFFIX = { i32: "Int32", u32: "Uint32", u16: "Uint16", i16: "Int16", u8: "Uint8" };

  function encodeFields(fields, obj) {
    const size = fields.reduce((n, [, type]) => n + FIELD_SIZE[type], 0);
    const payload = new Uint8Array(size);
    const dv = new DataView(payload.buffer);
    let off = 0;
    for (const [key, type, scale = 1, offset = 0, clamp] of fields) {
      let raw = Math.round((obj[key] ?? 0) * scale) + offset;
      if (clamp) raw = clamp(raw);
      if (type === "u8") payload[off] = raw & 0xFF;
      else dv[`set${FIELD_SUFFIX[type]}`](off, type === "u32" ? raw >>> 0 : raw, false);
      off += FIELD_SIZE[type];
    }
    return payload;
  }

  function decodeFields(fields, dv) {
    const obj = {};
    let off = 0;
    for (const [key, type, scale = 1, offset = 0] of fields) {
      const raw = type === "u8" ? dv.getUint8(off) : dv[`get${FIELD_SUFFIX[type]}`](off, false);
      obj[key] = (raw - offset) / scale;
      off += FIELD_SIZE[type];
    }
    return obj;
  }

  // 0x02 GPS — see crsf.md#0x02-gps. altitudeM carries a +1000m offset per spec.
  const GPS_FIELDS = [
    ["latitude",       "i32", 1e7],
    ["longitude",      "i32", 1e7],
    ["groundspeedKmh", "u16", 100, 0, clampU16],
    ["headingDeg",     "u16", 100, 0, clampU16],
    ["altitudeM",      "u16", 1, 1000, clampU16],
    ["satellites",     "u8"],
  ];

  function crsfEncodeGPS(coords) {
    return crsfBuildFrame(CRSF_GPS, encodeFields(GPS_FIELDS, coords));
  }

  function crsfDecodeGPS(frame) {
    if (frame.length < 3 + 15 || frame[2] !== CRSF_GPS) return null;
    return decodeFields(GPS_FIELDS, new DataView(frame.buffer, frame.byteOffset + 3, 15));
  }

  // 0x13 Accel/Gyro — see crsf.md#0x13-accel-gyro. Scales: gyro LSB =
  // INT16_MAX/2000 DPS, accel LSB = INT16_MAX/16 G.
  const GYRO_LSB_PER_DPS = 32767 / 2000;
  const ACC_LSB_PER_G    = 32767 / 16;
  const ACCEL_GYRO_FIELDS = [
    ["sampleTimeUs", "u32"],
    ["gyroX", "i16", GYRO_LSB_PER_DPS, 0, clampI16],
    ["gyroY", "i16", GYRO_LSB_PER_DPS, 0, clampI16],
    ["gyroZ", "i16", GYRO_LSB_PER_DPS, 0, clampI16],
    ["accX",  "i16", ACC_LSB_PER_G, 0, clampI16],
    ["accY",  "i16", ACC_LSB_PER_G, 0, clampI16],
    ["accZ",  "i16", ACC_LSB_PER_G, 0, clampI16],
    ["gyroTempC", "i16", 100, 0, clampI16],
  ];

  function crsfEncodeAccelGyro(sample) {
    return crsfBuildFrame(CRSF_ACCEL_GYRO, encodeFields(ACCEL_GYRO_FIELDS, sample));
  }

  function crsfDecodeAccelGyro(frame) {
    if (frame.length < 3 + 18 || frame[2] !== CRSF_ACCEL_GYRO) return null;
    return decodeFields(ACCEL_GYRO_FIELDS, new DataView(frame.buffer, frame.byteOffset + 3, 18));
  }

  // Mirrors UserControl.GetChannels() (Go). CRSF channels are native
  // 11-bit values, not 1000-2000 PWM microseconds: RC_MIN/RC_CENTER/RC_MAX
  // below are CRSF's standard 172/992/1811 endpoints.
  const RC_MIN = 172, RC_CENTER = 992, RC_MAX = 1811;

  // Mirrors boolToChannel(): true -> RC_MAX, false -> RC_MIN.
  function boolToChannel(b) { return b ? RC_MAX : RC_MIN; }

  // Mirrors toRCValue(): asymmetric scale around RC_CENTER so that
  // v in [-1,0] maps onto [RC_MIN,RC_CENTER] and v in (0,1] maps onto
  // (RC_CENTER,RC_MAX]. Note the strict "0 < v" branch, matching Go.
  function toRCValue(v) {
    const a = v > 0 ? (RC_MAX - RC_CENTER) : (RC_CENTER - RC_MIN);
    return Math.floor(v * a + RC_CENTER);
  }

  // Mirrors UserControl.GetChannels(): channels 8-15 are left at 0,
  // same as the Go array literal's zero-value tail.
  function crsfChannels(ctrl) {
    const ch = new Uint16Array(16);
    ch[0] = toRCValue(ctrl.throttle);
    ch[1] = toRCValue(ctrl.steer);
    ch[2] = boolToChannel(ctrl.light);
    ch[3] = 1000;
    ch[4] = boolToChannel(ctrl.armed);
    ch[5] = 1000;
    ch[6] = 1000;
    ch[7] = 1000;
    return ch;
  }

  // Mirrors buildRCFrame(): 16 channels * 11 bits packed LSB-first into
  // 22 payload bytes, framed as SYNC/LEN/TYPE/PAYLOAD/CRC.
  function crsfBuildRCFrame(channels) {
    const payload = new Uint8Array(22);
    let bitBuffer = 0, bitCount = 0, pos = 0;
    for (let ch = 0; ch < 16; ch++) {
      const v = channels[ch] & 0x07FF;
      bitBuffer |= (v << bitCount);
      bitCount += 11;
      while (bitCount >= 8) {
        payload[pos++] = bitBuffer & 0xFF;
        bitBuffer >>>= 8;
        bitCount -= 8;
      }
    }
    if (bitCount > 0) payload[pos] = bitBuffer & 0xFF;

    const frame = new Uint8Array(3 + payload.length + 1);
    frame[0] = CRSF_SYNC;
    frame[1] = 1 + payload.length + 1;
    frame[2] = CRSF_RC_CHANNELS;
    frame.set(payload, 3);
    frame[frame.length - 1] = crsfCrc8(frame.subarray(2, frame.length - 1));
    return frame;
  }

  // Reverse of crsfBuildRCFrame(): unpacks the 22-byte payload back into
  // 16 11-bit channel values. Channel indices match UserControl.GetChannels()
  // (0=throttle, 1=steer, 2=light, 4=armed).
  function crsfDecodeRCChannels(frame) {
    if (frame.length < 3 + 22 || frame[2] !== CRSF_RC_CHANNELS) return null;
    const payload = frame.subarray(3, 3 + 22);
    const channels = new Uint16Array(16);
    let bitBuffer = 0, bitCount = 0, chIdx = 0;
    for (let i = 0; i < payload.length && chIdx < 16; i++) {
      bitBuffer |= (payload[i] << bitCount);
      bitCount += 8;
      while (bitCount >= 11 && chIdx < 16) {
        channels[chIdx++] = bitBuffer & 0x07FF;
        bitBuffer >>>= 11;
        bitCount -= 11;
      }
    }
    return channels;
  }

  // Mirrors CRSFParser.Feed(): sync-scans a growing buffer and yields
  // complete, CRC-validated frames.
  //
  // Known hardware quirk: this Pico firmware's battery-sensor frames
  // (and the Go lib's buildBatteryFrame/decodeBatteryFrame that match
  // it) set length=8 counting only the 8-byte payload, forgetting to
  // include type+crc — so the real frame on the wire is 12 bytes, not
  // the 10 bytes that `length+2` would imply. Trusting the length byte
  // blindly truncates the frame and the CRC check silently fails every
  // time. We special-case that exact (type, length) combination so the
  // rest of the framing stays spec-correct for every other frame type.
  class CRSFParser {
    constructor() { this.buffer = new Uint8Array(0); }
    feed(data) {
      const merged = new Uint8Array(this.buffer.length + data.length);
      merged.set(this.buffer, 0);
      merged.set(data, this.buffer.length);
      this.buffer = merged;

      const frames = [];
      for (;;) {
        if (this.buffer.length < 2) break;
        if (this.buffer[0] !== CRSF_SYNC) { this.buffer = this.buffer.subarray(1); continue; }

        const length = this.buffer[1];
        if (length < 2 || length > 62) { this.buffer = this.buffer.subarray(1); continue; }

        // Need the type byte to detect the battery-frame quirk below.
        if (this.buffer.length < 3) break;
        const type = this.buffer[2];

        let total = length + 2; // spec: Sync + Length bytes precede Type+Payload+CRC
        if (type === CRSF_BATTERY && length === 8) total = 12; // hardware quirk

        if (total > 64) { this.buffer = this.buffer.subarray(1); continue; }
        if (this.buffer.length < total) break;

        const frame = this.buffer.slice(0, total);
        this.buffer = this.buffer.subarray(total);

        if (crsfCrc8(frame.subarray(2, total - 1)) !== frame[total - 1]) continue;
        frames.push(frame);
      }
      return frames;
    }
  }

  // Reads voltage from a battery-sensor frame's payload directly. The
  // parser above now frames these correctly (including the length-byte
  // quirk workaround), so this just reads the two big-endian voltage
  // bytes that follow the type byte.
  function crsfDecodeBattery(frame) {
    if (frame.length < 5 || frame[2] !== CRSF_BATTERY) return null;
    return ((frame[3] << 8) | frame[4]) / 100.0;
  }

  const ui = {
    status(id, text, kind="") {
      const e = $(id);
      e.textContent = text || "";
      e.className = "status-line" + (kind ? " " + kind : "");
    },
    led(id, state) { $(id).className = "led st-" + state; },
    log(dir, label, data) {
      const list = $("logList"), empty = list.querySelector(".log-empty");
      empty?.remove();

      let text = String(data ?? ""), hex = "";
      if (data instanceof Uint8Array) {
        hex = [...data].slice(0,20).map(b => b.toString(16).padStart(2,"0")).join(" ");
        if (data.length > 20) hex += " …";
        text = new TextDecoder().decode(data)
          .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ".");
        text = text + (hex ? "   [" + hex + "]" : "");
      }

      const li = document.createElement("li");
      li.className = dir;
      li.innerHTML = `<span class="t">${new Date().toTimeString().slice(0,8)}</span>
        <span class="d">${label}</span><span class="m"></span>`;
      li.querySelector(".m").textContent = text;
      list.appendChild(li);
      list.scrollTop = list.scrollHeight;
      while (list.children.length > 300) list.firstChild.remove();
    }
  };

  const serial = {
    setUI(connected, text, kind) {
      $("btnConnectSerial").disabled = connected;
      $("btnConnectWebUSB").disabled = connected;
      $("btnDisconnectSerial").disabled = !connected;
      if (text !== undefined) ui.status("serialStatus", text, kind);
    },

    data(bytes) {
      ui.log("tx", "ser→net", bytes);
      if (state.dc?.readyState === "open") state.dc.send(bytes);
    },

    async write(bytes) {
      if (!state.serial)
        return ui.log("err", "sys", `Serial not connected — dropped ${bytes.length} byte(s).`);
      try { await state.serial.write(bytes); }
      catch (e) { ui.log("err", "sys", "Serial write error: " + e.message); }
    },

    async disconnect() {
      const s = state.serial;
      state.serial = null;
      try { await s?.close(); } catch {}
      this.setUI(false, "Disconnected.");
    },

    async native() {
      if (!navigator.serial)
        return ui.status("serialStatus", "Web Serial API not available in this browser.", "error");

      try {
        const port = await navigator.serial.requestPort();
        const baud = +$("baudRate").value || 115200;
        await port.open({baudRate:baud});

        let reader, reading = false;
        const writer = port.writable.getWriter();

        state.serial = {
          write: bytes => writer.write(bytes),
          async start() {
            reading = true;
            try {
              reader = port.readable.getReader();
              while (reading) {
                const {value,done} = await reader.read();
                if (done) break;
                if (value?.length) serial.data(value);
              }
            } catch (e) {
              if (reading) ui.log("err","sys","Serial read error: " + e.message);
            } finally { try { reader?.releaseLock(); } catch {} }
          },
          async close() {
            reading = false;
            try { await reader?.cancel(); } catch {}
            try { writer.releaseLock(); } catch {}
            try { await port.close(); } catch {}
          }
        };

        this.setUI(true, `Connected via Web Serial at ${baud} baud.`, "ok");
        ui.log("rx","sys",`Serial port connected via Web Serial (${baud} baud).`);
        state.serial.start();

        port.addEventListener?.("disconnect", () => {
          ui.log("err","sys","Serial device disconnected.");
          this.disconnect();
        });
      } catch (e) {
        ui.status("serialStatus", "Serial error: " + (e.message || e.name), "error");
      }
    },

    async webusb() {
      if (!navigator.usb)
        return ui.status("serialStatus", "WebUSB not available in this browser.", "error");

      try {
        const baud = +$("baudRate").value || 115200;
        const device = await navigator.usb.requestDevice({filters:USB_FILTERS});
        await device.open();
        if (!device.configuration) await device.selectConfiguration(1);

        let vendor, cdcCtrl, cdcData;
        for (const i of device.configuration.interfaces) {
          const c = i.alternate.interfaceClass;
          if (c === 0xff && !vendor) vendor = i;
          if (c === 2 && !cdcCtrl) cdcCtrl = i;
          if (c === 10 && !cdcData) cdcData = i;
        }

        const ch340 = device.vendorId === 0x1a86;
        const ftdi = device.vendorId === 0x0403;
        const pico = device.vendorId === 0x2e8a;
        let iface, cdc = false;

        if (vendor) {
          iface = vendor;
          await device.claimInterface(iface.interfaceNumber);
          if (ch340) await ch340Init(device, baud);
          else if (ftdi) await ftdiInit(device, baud);
          else if (!pico) throw Error("Unsupported vendor USB serial device");
        } else if (cdcData) {
          iface = cdcData;
          cdc = true;
          if (cdcCtrl) {
            await device.claimInterface(cdcCtrl.interfaceNumber);
            await device.controlTransferOut({
              requestType:"class", recipient:"interface", request:0x22,
              value:3, index:cdcCtrl.interfaceNumber
            });
          }
          await device.claimInterface(cdcData.interfaceNumber);
        } else throw Error("No supported USB serial interface found");

        let epIn, epOut, epSize = 64;
        for (const ep of iface.alternate.endpoints) {
          if (ep.type !== "bulk") continue;
          if (ep.direction === "in") { epIn = ep.endpointNumber; epSize = ep.packetSize || 64; }
          else epOut = ep.endpointNumber;
        }
        if (epIn == null || epOut == null) throw Error("No bulk endpoints found");

        let reading = false;
        state.serial = {
          write: bytes => device.transferOut(epOut, bytes),
          async start() {
            reading = true;
            while (reading) {
              try {
                const r = await device.transferIn(epIn, epSize);
                if (r.status !== "ok" || !r.data?.byteLength) continue;
                let bytes = new Uint8Array(r.data.buffer);
                if (ftdi) bytes = bytes.subarray(2);
                if (bytes.length) serial.data(bytes);
              } catch (e) {
                if (reading) ui.log("err","sys","WebUSB read error: " + e.message);
                break;
              }
            }
          },
          async close() { reading = false; try { await device.close(); } catch {} }
        };

        const name = cdc ? "CDC-ACM" : ch340 ? "CH340/CH341" :
          ftdi ? "FTDI" : "Pico WebUSB";
        this.setUI(true, `Connected via WebUSB (${name})${cdc||pico ? "" : ` at ${baud} baud`}.`, "ok");
        ui.log("rx","sys",`Serial connected via WebUSB (${name}).`);
        state.serial.start();

        navigator.usb.addEventListener("disconnect", function onDisconnect(e) {
          if (e.device !== device) return;
          navigator.usb.removeEventListener("disconnect", onDisconnect);
          ui.log("err","sys","USB device disconnected.");
          serial.disconnect();
        });
      } catch (e) {
        ui.status("serialStatus", "WebUSB error: " + (e.message || e.name), "error");
      }
    }
  };

  const USB_FILTERS = [
    {vendorId:0x1a86,productId:0x7523},{vendorId:0x1a86,productId:0x5523},
    {vendorId:0x0403,productId:0x6001},{vendorId:0x0403,productId:0x6010},
    {vendorId:0x0403,productId:0x6011},{vendorId:0x0403,productId:0x6014},
    {vendorId:0x0403,productId:0x6015},{vendorId:0x2e8a,productId:0x000a}
  ];

  const CH340_BAUD = {
    2400:[0xd901,0x0038],4800:[0x6402,0x001f],9600:[0xb202,0x0013],
    19200:[0xd902,0x000d],38400:[0x6403,0x000a],115200:[0xcc03,0x0008]
  };

  async function ch340Init(d, baud) {
    const p = CH340_BAUD[baud];
    if (!p) throw Error("Unsupported CH340 baud rate");
    const out = (request,value,index) =>
      d.controlTransferOut({requestType:"vendor",recipient:"device",request,value,index});
    const input = (request,value,index,len) =>
      d.controlTransferIn({requestType:"vendor",recipient:"device",request,value,index},len);
    const baudSet = () => Promise.all([
      out(0x9a,0x1312,p[0]), out(0x9a,0x0f2c,p[1])
    ]);
    await input(0x5f,0,0,8); await out(0xa1,0,0); await baudSet();
    await input(0x95,0x2518,0,8); await out(0x9a,0x2518,0x50);
    await input(0x95,0x0706,0,8); await out(0xa1,0x501f,0xd90a);
    await baudSet(); await out(0xa4,0x9f,0);
  }

  const FTDI_FRAC = [0,3,2,4,1,5,6,7];
  function ftdiBaud(baud) {
    const div = Math.floor(3000000/baud);
    const frac = Math.round((3000000%baud)*8/baud)%8;
    return ((div & 0x3fff) | (FTDI_FRAC[frac]<<14)) & 0xffff;
  }

  async function ftdiInit(d, baud) {
    const out = (request,value) => d.controlTransferOut({
      requestType:"vendor",recipient:"device",request,value,index:0
    });
    await out(0,0); await out(2,0); await out(3,ftdiBaud(baud));
    await out(4,8); await out(1,0x303);
  }

  const rtc = {
    waitIce(peer, timeout = 60000) {
      if (peer.iceGatheringState === "complete") return Promise.resolve();

      return new Promise((resolve, reject) => {
        let timer;
        const done = () => {
          if (peer.iceGatheringState !== "complete") return;
          clearTimeout(timer);
          peer.removeEventListener("icegatheringstatechange", done);
          resolve();
        };
        peer.addEventListener("icegatheringstatechange", done);
        timer = setTimeout(() => {
          peer.removeEventListener("icegatheringstatechange", done);
          reject(Error("ICE gathering did not complete within 60 seconds."));
        }, timeout);
      });
    },

    create() {
      const pc = new RTCPeerConnection({iceServers:ICE, iceCandidatePoolSize:1});
      ui.led("ledConn","amber");

      pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        ui.led("ledConn", s === "connected" ? "green" :
          ["new","connecting"].includes(s) ? "amber" : "red");
        ui.log(s === "connected" ? "rx" : "err", "sys",
          `WebRTC connectionState: ${s}`);
      };

      pc.oniceconnectionstatechange = () => {
        ui.log(
          ["connected","completed"].includes(pc.iceConnectionState) ? "rx" : "err",
          "sys",
          `ICE connectionState: ${pc.iceConnectionState}`
        );
      };

      pc.onicegatheringstatechange = () => {
        ui.log("rx", "sys", `ICE gatheringState: ${pc.iceGatheringState}`);
      };

      pc.onicecandidateerror = e => {
        ui.log("err", "sys",
          `ICE candidate error ${e.errorCode}: ${e.errorText || "unknown"}`);
      };

      pc.onicecandidate = e => {
        if (e.candidate)
          ui.log("rx", "sys",
            `ICE candidate: ${e.candidate.candidate.split(" ")[7] || "candidate"}`);
      };

      pc.onnegotiationneeded = () => {
        ui.log("rx", "sys", "WebRTC negotiation needed.");
      };

      return pc;
    },

    channel(ch) {
      ch.binaryType = "arraybuffer";
      state.dc = ch;
      ch.onopen = () => {
        ui.led("ledData","green");
        ui.log("rx","sys","Data channel open.");
        if (state.mode === "viewer") control.setEnabled(true);
      };
      ch.onclose = () => {
        ui.led("ledData","red");
        ui.log("err","sys","Data channel closed.");
        if (state.mode === "viewer") control.setEnabled(false);
      };
      ch.onerror = () => ui.led("ledData","red");
      ch.onmessage = e => {
        const bytes = new Uint8Array(e.data);
        if (state.mode === "camera") {
          ui.log("rx","net→ser",bytes);
          serial.write(bytes);

          if (!state.rxParser) state.rxParser = new CRSFParser();
          for (const frame of state.rxParser.feed(bytes)) {
            if (frame[2] === CRSF_RC_CHANNELS) {
              const channels = crsfDecodeRCChannels(frame);
              if (channels) torch.set(channels[2] > 1500); // ch2 = Light, see UserControl.GetChannels()
            }
          }
        } else {
          ui.log("rx","cam→you",bytes);
          control.handleTelemetry(bytes);
        }
      };
    }
  };

  const sensors = {
    watchId: null, motionHandler: null, lastMotionSend: 0,

    toggle(enabled) { enabled ? this.start() : this.stop(); },

    async start() {
      let anyStarted = false;

      if (navigator.geolocation) {
        this.watchId = navigator.geolocation.watchPosition(
          pos => this.sendGPS(pos.coords),
          err => ui.log("err","sys","Geolocation error: " + err.message),
          { enableHighAccuracy: true, maximumAge: 1000 }
        );
        anyStarted = true;
      } else {
        ui.log("err","sys","Geolocation not available in this browser.");
      }

      if (window.DeviceMotionEvent) {
        try {
          if (typeof DeviceMotionEvent.requestPermission === "function") {
            const perm = await DeviceMotionEvent.requestPermission();
            if (perm === "granted") { this.attachMotion(); anyStarted = true; }
            else ui.log("err","sys","Motion sensor permission denied.");
          } else {
            this.attachMotion();
            anyStarted = true;
          }
        } catch (e) {
          ui.log("err","sys","Motion sensor request failed: " + e.message);
        }
      } else {
        ui.log("err","sys","Motion sensors not available in this browser.");
      }

      ui.status("telemetryStatus",
        anyStarted ? "Telemetry sensors active." : "No GPS or motion sensors available.",
        anyStarted ? "ok" : "err");
    },

    attachMotion() {
      this.motionHandler = e => this.onMotion(e);
      window.addEventListener("devicemotion", this.motionHandler);
    },

    stop() {
      if (this.watchId !== null) { navigator.geolocation.clearWatch(this.watchId); this.watchId = null; }
      if (this.motionHandler) { window.removeEventListener("devicemotion", this.motionHandler); this.motionHandler = null; }
      ui.status("telemetryStatus", "");
    },

    sendGPS(coords) {
      if (state.mode !== "camera" || state.dc?.readyState !== "open") return;
      const frame = crsfEncodeGPS({
        latitude: coords.latitude,
        longitude: coords.longitude,
        groundspeedKmh: coords.speed != null ? coords.speed * 3.6 : 0,
        headingDeg: (coords.heading != null && !Number.isNaN(coords.heading)) ? coords.heading : 0,
        altitudeM: coords.altitude != null ? coords.altitude : 0,
        satellites: 0 // not exposed by the browser Geolocation API
      });
      try { state.dc.send(frame); } catch (e) { ui.log("err","sys","GPS send failed: " + e.message); }
    },

    // Throttled to ~10 Hz — devicemotion can fire far faster than that,
    // and this channel is shared with serial passthrough + RC control.
    onMotion(e) {
      const now = performance.now();
      if (now - this.lastMotionSend < 100) return;
      this.lastMotionSend = now;
      if (state.mode !== "camera" || state.dc?.readyState !== "open") return;

      const rot = e.rotationRate || {};
      const acc = (e.acceleration && e.acceleration.x != null) ? e.acceleration : (e.accelerationIncludingGravity || {});

      // Best-effort mapping from the browser's device-frame axes to the
      // spec's vehicle NEU bodyframe (X=roll/fwd, Y=pitch/right, Z=yaw/up).
      // Exact signs depend on how this device is physically mounted on the
      // vehicle — flip as needed for your mounting.
      const frame = crsfEncodeAccelGyro({
        sampleTimeUs: Math.floor(now * 1000) >>> 0,
        gyroX: rot.gamma || 0,
        gyroY: rot.beta  || 0,
        gyroZ: rot.alpha || 0,
        accX: acc.y != null ? acc.y / 9.80665 : 0,
        accY: acc.x != null ? acc.x / 9.80665 : 0,
        accZ: acc.z != null ? acc.z / 9.80665 : 0,
        gyroTempC: 0
      });
      try { state.dc.send(frame); } catch (e2) { ui.log("err","sys","IMU send failed: " + e2.message); }
    }
  };

  const torch = {
    on: false,

    activeTracks() {
      return (state.streams || [])
        .map(s => s.stream?.getVideoTracks()[0])
        .filter(Boolean);
    },

    // Dumps the raw capabilities object per camera. This is the ground
    // truth for whether the browser exposes torch control at all on
    // this device — if "torch" is missing from every dump below, the
    // browser/OS combo simply doesn't expose it via web APIs (this is
    // a known gap on iOS Safari, for example) and no retry logic can
    // work around that.
    attach(streams) {
      this.on = false;
      for (const { stream, label } of streams) {
        const track = stream?.getVideoTracks()[0];
        if (!track) continue;
        let capsStr;
        try {
          const caps = track.getCapabilities ? track.getCapabilities() : null;
          capsStr = caps ? JSON.stringify(caps) : "track.getCapabilities() not supported by this browser";
        } catch (e) {
          capsStr = "getCapabilities() threw: " + e.message;
        }
        ui.log("rx","sys", `${label}: capabilities = ${capsStr}`);
      }
    },

    // Tries every currently active camera track, not just ones that
    // reported torch support, and logs the *actual* error per camera
    // instead of swallowing it — silent failures give no way to tell
    // "unsupported" apart from "supported but something else broke".
    async set(on) {
      if (on === this.on) return;
      this.on = on;

      const tracks = this.activeTracks();
      if (!tracks.length) {
        ui.log("err","sys", `Light ${on ? "ON" : "OFF"} — no active camera tracks to apply torch to.`);
        return;
      }

      let applied = 0;
      for (const track of tracks) {
        const label = track.label || "camera";
        try {
          await track.applyConstraints({ advanced: [{ torch: on }] });
          applied++;
          ui.log("rx","sys", `${label}: torch ${on ? "ON" : "OFF"} applied.`);
        } catch (e) {
          ui.log("err","sys", `${label}: torch ${on ? "ON" : "OFF"} failed — ${e.name || "Error"}: ${e.message || e}`);
        }
      }

      ui.log("rx","sys", applied
        ? `Light ${on ? "ON" : "OFF"} — torch applied on ${applied}/${tracks.length} camera(s).`
        : `Light ${on ? "ON" : "OFF"} — no active camera accepted torch control.`);
    }
  };

  const camera = {
    async devices() {
      try {
        const cams = (await navigator.mediaDevices.enumerateDevices())
          .filter(d => d.kind === "videoinput");
        $("cameraSelect").innerHTML = cams.map((d,i) =>
          `<option value="${d.deviceId}">${d.label || `Camera ${i+1}`}</option>`).join("");
        $("cameraSelect").disabled = !cams.length;
        return cams;
      } catch { return []; }
    },

    async start() {
      await this.stop();

      let devices;
      try {
        devices = (await navigator.mediaDevices.enumerateDevices())
          .filter(d => d.kind === "videoinput");
      } catch (e) {
        ui.led("ledMedia","red");
        ui.status("cameraStatus", "Could not enumerate cameras: " + (e.message || e.name), "error");
        ui.log("err","sys","Camera enumeration error: " + (e.message || e.name));
        return;
      }

      // Some mobile browsers don't expose stable device IDs until camera
      // permission has been granted once.
      if (devices.some(d => !d.deviceId)) {
        try {
          const probe = await navigator.mediaDevices.getUserMedia({
            video:true, audio:false
          });
          probe.getTracks().forEach(t => t.stop());
          devices = (await navigator.mediaDevices.enumerateDevices())
            .filter(d => d.kind === "videoinput");
        } catch (e) {
          ui.log("err","sys","Camera permission probe: " + (e.message || e.name));
        }
      }

      if (!devices.length) {
        ui.led("ledMedia","red");
        ui.status("cameraStatus", "No cameras found.", "error");
        return;
      }

      const results = [];

      // Do this one camera at a time. A phone may expose several logical
      // cameras while its camera HAL only permits limited concurrency.
      for (const [index, device] of devices.entries()) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: {deviceId:{exact:device.deviceId}},
            audio: false
          });

          const track = stream.getVideoTracks()[0];
          results.push({
            device, index, stream,
            label: device.label || track?.label || `Camera ${index + 1}`
          });

          ui.log("rx","sys",
            `${device.label || `Camera ${index + 1}`}: camera started.`);
        } catch (e) {
          const error = e.message || e.name || "Unknown camera error";
          results.push({
            device, index, error,
            label: device.label || `Camera ${index + 1}`
          });
          ui.log("err","sys",
            `${device.label || `Camera ${index + 1}`}: ${error}`);
        }
      }

      state.cameraResults = results;
      state.streams = results.filter(x => x.stream);
      state.cameraErrors = results.filter(x => !x.stream);
      torch.attach(state.streams);

      this.render(state.streams);

      const active = state.streams.length;
      const failed = state.cameraErrors.length;

      ui.led("ledMedia", active ? "green" : "red");
      $("btnCreateOffer").disabled = !active;
      $("btnTestTorch").disabled = !active;

      const summary = `${active} camera${active === 1 ? "" : "s"} active` +
        (failed ? `, ${failed} unavailable.` : ".");
      ui.status("cameraStatus", summary, active ? "ok" : "error");

      if (active) {
        ui.log("rx","sys",
          `Ready for WebRTC: ${active} working camera(s), ${failed} unavailable.`);
      } else {
        ui.log("err","sys","No cameras could be started.");
      }
    },

    render(streams) {
      const grid = $("localGrid");
      if (!grid) return;
      grid.replaceChildren();
      const errors = $("cameraErrors");
      if (errors) {
        errors.replaceChildren();
        state.cameraErrors.forEach(({device,index,error}) => {
          const row = document.createElement("div");
          row.className = "camera-error";
          row.textContent = `✗ ${device.label || `Camera ${index+1}`}: ${error}`;
          errors.append(row);
        });
      }
      streams.forEach(({device,stream,index}) => {
        const box=document.createElement("div"), video=document.createElement("video");
        const label=document.createElement("div");
        box.className="cam-box"; label.className="label";
        video.autoplay=video.playsInline=video.muted=true;
        video.srcObject=stream;
        label.textContent=device.label || `Camera ${index+1}`;
        box.append(video,label); grid.append(box);
      });
    },

    async stop() {
      state.streams?.forEach(({stream}) =>
        stream.getTracks().forEach(t => t.stop()));
      state.streams=[];
      state.cameraResults=[];
      state.cameraErrors=[];
      torch.attach([]);
      $("btnTestTorch").disabled = true;
      $("localGrid")?.replaceChildren();
      $("cameraErrors")?.replaceChildren();
    }
  };

  const viewer = {
    streams: new Map(),

    addTrack(track, stream) {
      if (track.kind !== "video") return;

      // Normally addTrack(track, stream) gives us the sender's stream.
      // Keep a fallback for browsers that report an empty streams array.
      if (!stream) {
        stream = new MediaStream([track]);
      }

      const id = stream.id || track.id;
      if (this.streams.has(id)) return;

      const grid = $("remoteGrid");
      if (!grid) return;

      const box = document.createElement("div");
      const video = document.createElement("video");
      const label = document.createElement("div");

      box.className = "cam-box";
      label.className = "label";
      video.autoplay = video.playsInline = true;
      video.srcObject = stream;

      label.textContent = `Camera ${this.streams.size + 1}`;
      box.append(video, label);
      grid.append(box);

      this.streams.set(id, {box, video, stream, track});

      $("emptyHint")?.setAttribute("hidden","");
      $("videoTagDot")?.classList.add("live");
      $("videoTagText").textContent =
        `${this.streams.size} camera${this.streams.size === 1 ? "" : "s"}`;
      ui.led("ledMedia","green");

      track.onended = () => {
        box.remove();
        this.streams.delete(id);
      };
    },

    clear() {
      this.streams.clear();
      $("remoteGrid")?.replaceChildren();
    }
  };

  const wakeLock = {
    sentinel: null,

    async acquire() {
      if (this.sentinel) return;
      if (!("wakeLock" in navigator)) {
        ui.log("err","sys",
          "Screen wake lock not available in this browser context (it requires HTTPS or " +
          "localhost, and browser support) — the screen may dim/lock and pause the control link.");
        return;
      }
      try {
        this.sentinel = await navigator.wakeLock.request("screen");
        this.sentinel.addEventListener("release", () => { this.sentinel = null; });
        ui.log("rx","sys","Screen wake lock acquired.");
      } catch (e) {
        ui.log("err","sys","Screen wake lock request failed: " + e.message);
      }
    },

    async release() {
      try { await this.sentinel?.release(); } catch {}
      this.sentinel = null;
    }
  };

  // --------------------------------------------------------------------
  // Viewer screen recorder.
  //
  // ARM is the user gesture that starts getDisplayMedia(), so the browser
  // can show its screen/window/tab picker. Recording continues until ARM
  // is disabled. Clips of 3 seconds or less are discarded.
  // --------------------------------------------------------------------
  const screenRecorder = {
    recorder: null,
    stream: null,
    chunks: [],
    startedAt: 0,
    stopping: null,

    supportedMimeType() {
      const types = [
        "video/webm;codecs=vp9",
        "video/webm;codecs=vp8",
        "video/webm"
      ];
      return types.find(type => MediaRecorder.isTypeSupported(type)) || "";
    },

    async start() {
      if (this.recorder && this.recorder.state !== "inactive") return true;

      if (!navigator.mediaDevices?.getDisplayMedia) {
        ui.log("err", "rec", "Screen Capture API is not available in this browser.");
        return false;
      }
      if (typeof MediaRecorder === "undefined") {
        ui.log("err", "rec", "MediaRecorder API is not available in this browser.");
        return false;
      }

      const mimeType = this.supportedMimeType();
      if (!mimeType) {
        ui.log("err", "rec", "No supported WebM MediaRecorder codec found.");
        return false;
      }

      try {
        // Keep this call in the ARM click's async call chain so the browser
        // is allowed to display the screen-sharing picker.
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: { ideal: 30, max: 60 } },
          audio: false
        });

        const track = stream.getVideoTracks()[0];
        if (!track) {
          stream.getTracks().forEach(t => t.stop());
          throw new Error("No video track was returned by screen capture.");
        }

        const recorder = new MediaRecorder(stream, { mimeType });
        this.stream = stream;
        this.recorder = recorder;
        this.chunks = [];
        this.startedAt = performance.now();
        this.stopping = null;

        recorder.ondataavailable = e => {
          if (e.data?.size) this.chunks.push(e.data);
        };

        recorder.onerror = e => {
          ui.log("err", "rec", "MediaRecorder error: " +
            (e.error?.message || e.error?.name || "unknown error"));
        };

        track.addEventListener("ended", () => {
          // If the browser's "Stop sharing" control is used, disarm first.
          // This avoids leaving the vehicle armed after capture disappears.
          ui.log("err", "rec", "Screen sharing ended.");
          if (state.ctrl.armed) {
            state.ctrl.armed = false;
            $("btnArm").classList.remove("on");
            this.stopAndHandle(true);
            control.sendFrame();
          } else {
            this.stopAndHandle(true);
          }
        }, { once: true });

        recorder.start(1000);
        ui.log("rx", "rec", `Screen recording started (${mimeType}).`);
        ui.status("controlStatus", "ARMED — screen recording active.", "ok");
        return true;
      } catch (e) {
        this.recorder = null;
        this.stream = null;
        this.chunks = [];
        this.startedAt = 0;

        if (e?.name === "NotAllowedError")
          ui.log("err", "rec", "Screen capture was cancelled or permission was denied.");
        else
          ui.log("err", "rec", "Screen capture failed: " + (e.message || e.name));
        return false;
      }
    },

    async stopAndHandle(discard = false) {
      if (this.stopping) return this.stopping;

      const recorder = this.recorder;
      const stream = this.stream;

      if (!recorder) {
        stream?.getTracks().forEach(t => t.stop());
        this.stream = null;
        this.chunks = [];
        this.startedAt = 0;
        return;
      }

      this.stopping = new Promise(resolve => {
        const finish = () => {
          const duration = Math.max(0, (performance.now() - this.startedAt) / 1000);
          const chunks = this.chunks;
          const mimeType = recorder.mimeType || "video/webm";

          this.recorder = null;
          this.stream = null;
          this.chunks = [];
          this.startedAt = 0;

          stream?.getTracks().forEach(t => t.stop());

          if (discard || duration <= 3) {
            ui.log("rx", "rec",
              `Recording discarded (${duration.toFixed(1)} s` +
              (discard ? ", capture ended)." : ", under 3 s)."));
            resolve();
            return;
          }

          const blob = new Blob(chunks, { type: mimeType });
          if (!blob.size) {
            ui.log("err", "rec", "Recording produced an empty video.");
            resolve();
            return;
          }

          const url = URL.createObjectURL(blob);
          const stamp = new Date().toISOString()
            .replace(/[:.]/g, "-")
            .replace(/Z$/, "");
          const filename = `viewer-recording-${stamp}.webm`;

          ui.log("rx", "rec",
            `Recording ready: ${(blob.size / 1048576).toFixed(1)} MiB, ${duration.toFixed(1)} s.`);

          const download = window.confirm(
            `Recording is ready (${duration.toFixed(1)} s).\n\nDownload ${filename}?`
          );

          if (download) {
            const a = document.createElement("a");
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            ui.log("rx", "rec", "Video download started.");
          } else {
            ui.log("rx", "rec", "Video download cancelled.");
          }

          URL.revokeObjectURL(url);
          resolve();
        };

        recorder.addEventListener("stop", finish, { once: true });

        if (recorder.state === "inactive") {
          finish();
        } else {
          try {
            recorder.stop();
          } catch (e) {
            ui.log("err", "rec", "Could not stop recorder: " + e.message);
            finish();
          }
        }
      }).finally(() => { this.stopping = null; });

      return this.stopping;
    }
  };


  // ARM-session telemetry/input logger. Data is kept only in memory while
  // armed and is converted to downloadable CSV files when ARM is released.
  const armLogger = {
    active: false,
    gps: [], battery: [], gyro: [], accel: [], input: [],
    last: { gps:null, battery:null, gyro:null, accel:null, input:null },
    urls: [],

    clearDownloads() {
      this.urls.forEach(url => URL.revokeObjectURL(url));
      this.urls = [];
      const box = $("armLogDownloads");
      if (box) box.hidden = true;
      const list = $("armLogDownloadList");
      if (list) list.replaceChildren();
    },

    reset() {
      this.clearDownloads();
      this.gps = []; this.battery = []; this.gyro = []; this.accel = []; this.input = [];
      this.last = { gps:null, battery:null, gyro:null, accel:null, input:null };
    },

    start() {
      this.reset();
      this.active = true;
    },

    stop() {
      if (!this.active) return;
      this.active = false;
      this.buildDownloads();
    },

    changed(prev, next) {
      if (!prev || prev.length !== next.length) return true;
      for (let i = 0; i < next.length; i++) if (prev[i] !== next[i]) return true;
      return false;
    },

    record(type, values) {
      if (!this.active) return;
      const prev = this.last[type];
      if (!this.changed(prev, values)) return;
      const row = [Date.now(), ...values];
      this[type].push(row);
      this.last[type] = values.slice();
    },

    csv(rows, headers) {
      const esc = v => {
        if (v === null || v === undefined) return '';
        const s = String(v);
        return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      return [headers, ...rows].map(row => row.map(esc).join(',')).join('\r\n') + '\r\n';
    },

    addDownload(name, text) {
      const blob = new Blob([text], {type:'text/csv;charset=utf-8'});
      const url = URL.createObjectURL(blob);
      this.urls.push(url);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.className = 'btn small';
      a.textContent = name;
      $("armLogDownloadList")?.appendChild(a);
    },

    buildDownloads() {
      const stamp = new Date().toISOString().replace(/[:.]/g,'-');
      this.addDownload(`gps-${stamp}.csv`, this.csv(this.gps, ['timestamp_ms_epoch','latitude','longitude']));
      this.addDownload(`battery-${stamp}.csv`, this.csv(this.battery, ['timestamp_ms_epoch','battery_voltage']));
      this.addDownload(`gyro-${stamp}.csv`, this.csv(this.gyro, ['timestamp_ms_epoch','gyroX','gyroY','gyroZ']));
      this.addDownload(`accel-${stamp}.csv`, this.csv(this.accel, ['timestamp_ms_epoch','accelX','accelY','accelZ']));
      this.addDownload(`stick-input-${stamp}.csv`, this.csv(this.input, ['timestamp_ms_epoch','throttle_input','steer_input']));
      const box = $("armLogDownloads");
      if (box) box.hidden = false;
    }
  };

  const control = {
    TX_INTERVAL_MS: 50, // ~20 Hz, well inside typical CRSF failsafe windows

    sendFrame() {
      if (state.dc?.readyState !== "open") return;
      const frame = crsfBuildRCFrame(crsfChannels(state.ctrl));
      try { state.dc.send(frame); }
      catch (e) { ui.log("err","sys","Control send failed: " + e.message); }
    },

    startLoop() {
      this.stopLoop();
      state.txTimer = setInterval(() => this.sendFrame(), this.TX_INTERVAL_MS);
    },

    stopLoop() {
      if (state.txTimer) clearInterval(state.txTimer);
      state.txTimer = null;
    },

    setEnabled(enabled) {
      $("btnArm").disabled = !enabled;
      $("btnLight").disabled = !enabled;
      $("joystickBase").classList.toggle("disabled", !enabled);
      $("viewerPairingCard").hidden = enabled;

      if (enabled) {
        this.startLoop();
        wakeLock.acquire();
        ui.status("controlStatus", "Link live — sending control frames.", "ok");
      } else {
        this.stopLoop();
        if (armLogger.active) armLogger.stop();
        wakeLock.release();
        state.ctrl.throttle = 0; state.ctrl.steer = 0;
        state.ctrl.armed = false; state.ctrl.light = false;
        joystick.center(false);
        $("btnArm").classList.remove("on"); $("btnLight").classList.remove("on");
        $("batteryVoltage").textContent = "— V";
        $("batteryVoltage").classList.add("stale");
        $("gpsPosition").textContent = "—";
        $("gpsPosition").classList.add("stale");
        $("gpsSub").textContent = "";
        $("gyroValues").textContent = "x — · y — · z —";
        $("gyroValues").classList.add("stale");
        $("accelValues").textContent = "x — · y — · z —";
        $("accelValues").classList.add("stale");
        ui.status("controlStatus", "");
      }
    },

    setAxes(throttle, steer) {
      state.ctrl.throttle = throttle;
      state.ctrl.steer = steer;
      armLogger.record("input", [throttle, steer]);
      $("throttleValue").textContent = Math.round(throttle * 100) + "%";
      $("steerValue").textContent = Math.round(steer * 100) + "%";
      this.sendFrame();
    },

    async toggleArm() {
      if (!state.ctrl.armed) {
        // ARM must not depend on the user's recording choice. If recording
        // is enabled, ask for screen capture first, but arm even when the
        // picker is cancelled or capture is otherwise unavailable.
        const recOnArm = $("chkRecOnArm")?.checked !== false;
        if (recOnArm) {
          const started = await screenRecorder.start();
          if (!started) {
            ui.log("tx", "you→cam", "Screen recording not started; continuing ARM without recording.");
          }
        }

        state.ctrl.armed = true;
        armLogger.start();
        armLogger.record("input", [state.ctrl.throttle, state.ctrl.steer]);
        $("btnArm").classList.add("on");
        ui.log("tx", "you→cam", "ARM ON" + (recOnArm ? " (recording requested)" : ""));
        this.sendFrame();
        return;
      }

      state.ctrl.armed = false;
      armLogger.stop();
      $("btnArm").classList.remove("on");
      ui.log("tx", "you→cam", "ARM OFF");
      this.sendFrame();
      await screenRecorder.stopAndHandle(false);
      ui.status("controlStatus", "Link live — sending control frames.", "ok");
    },

    toggleLight() {
      state.ctrl.light = !state.ctrl.light;
      $("btnLight").classList.toggle("on", state.ctrl.light);
      ui.log("tx","you→cam", `LIGHT ${state.ctrl.light ? "ON" : "OFF"}`);
      this.sendFrame();
    },

    handleTelemetry(bytes) {
      if (!state.rxParser) state.rxParser = new CRSFParser();
      const frames = state.rxParser.feed(bytes);
      for (const frame of frames) {
        switch (frame[2]) {
          case CRSF_BATTERY: {
            const voltage = crsfDecodeBattery(frame);
            if (voltage !== null) {
              armLogger.record("battery", [voltage]);
              const el = $("batteryVoltage");
              el.textContent = voltage.toFixed(2) + " V";
              el.classList.remove("stale");
            }
            break;
          }
          case CRSF_GPS: {
            const gps = crsfDecodeGPS(frame);
            if (gps) {
              armLogger.record("gps", [gps.latitude, gps.longitude]);
              const posEl = $("gpsPosition");
              posEl.textContent = `${gps.latitude.toFixed(6)}, ${gps.longitude.toFixed(6)}`;
              posEl.classList.remove("stale");
              $("gpsSub").textContent =
                `alt ${gps.altitudeM.toFixed(0)} m · spd ${gps.groundspeedKmh.toFixed(1)} km/h · hdg ${gps.headingDeg.toFixed(0)}° · sats ${gps.satellites}`;
            }
            break;
          }
          case CRSF_ACCEL_GYRO: {
            const imu = crsfDecodeAccelGyro(frame);
            if (imu) {
              armLogger.record("gyro", [imu.gyroX, imu.gyroY, imu.gyroZ]);
              armLogger.record("accel", [imu.accX, imu.accY, imu.accZ]);
              const gEl = $("gyroValues");
              gEl.textContent = `x ${imu.gyroX.toFixed(1)} · y ${imu.gyroY.toFixed(1)} · z ${imu.gyroZ.toFixed(1)} °/s`;
              gEl.classList.remove("stale");
              const aEl = $("accelValues");
              aEl.textContent = `x ${imu.accX.toFixed(2)} · y ${imu.accY.toFixed(2)} · z ${imu.accZ.toFixed(2)} g`;
              aEl.classList.remove("stale");
            }
            break;
          }
        }
      }
    }
  };

  const joystick = {
    base: null, knob: null, dragging: false, pointerId: null,

    init() {
      this.base = $("joystickBase");
      this.knob = $("joystickKnob");
      this.base.addEventListener("pointerdown", e => this.start(e));
      window.addEventListener("pointermove", e => this.move(e));
      window.addEventListener("pointerup", e => this.end(e));
      window.addEventListener("pointercancel", e => this.end(e));
    },

    start(e) {
      if (this.base.classList.contains("disabled")) return;
      this.dragging = true;
      this.pointerId = e.pointerId;
      try { this.base.setPointerCapture(e.pointerId); } catch {}
      this.knob.classList.add("active");
      this.update(e.clientX, e.clientY);
      e.preventDefault();
    },

    move(e) {
      if (!this.dragging || e.pointerId !== this.pointerId) return;
      this.update(e.clientX, e.clientY);
      e.preventDefault();
    },

    end(e) {
      if (!this.dragging || e.pointerId !== this.pointerId) return;
      this.dragging = false;
      this.pointerId = null;
      this.knob.classList.remove("active");
      this.center(true);
    },

    // One thumb, two axes: horizontal drag = steer, vertical drag = throttle
    // (up = forward). Each axis clamps independently to the base's half-
    // width/half-height, i.e. a rectangular travel area — not a circular
    // one — so full forward and full right/left are reachable at once,
    // same as a real RC transmitter gimbal (not a circular joystick cap).
    update(clientX, clientY) {
      const rect = this.base.getBoundingClientRect();
      const halfW = rect.width / 2;
      const halfH = rect.height / 2;
      let dx = clientX - (rect.left + halfW);
      let dy = clientY - (rect.top + halfH);
      dx = Math.max(-halfW, Math.min(halfW, dx));
      dy = Math.max(-halfH, Math.min(halfH, dy));

      this.knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      control.setAxes(-dy / halfH, dx / halfW);
    },

    center(send) {
      this.knob.style.transform = "translate(-50%, -50%)";
      if (send) control.setAxes(0, 0);
      else { state.ctrl.throttle = 0; state.ctrl.steer = 0; }
      $("throttleValue").textContent = "0%";
      $("steerValue").textContent = "0%";
    }
  };

  const signaling = {
    async offer() {
      const button = $("btnCreateOffer");
      const streams = state.streams.filter(x => x.stream?.active !== false);

      if (!streams.length)
        return ui.status("cameraStatus", "No working cameras to send.", "error");

      button.disabled = true;

      try {
        state.pc?.close();
        state.pc = rtc.create();
        rtc.channel(state.pc.createDataChannel("serial"));

        // Only successfully opened cameras become WebRTC tracks.
        // Failed cameras never enter the PeerConnection or SDP.
        for (const {stream,label} of streams) {
          const track = stream.getVideoTracks()[0];
          if (!track) continue;

          track.contentHint = "motion";
          const transceiver = state.pc.addTransceiver(track, {
            direction: "sendonly",
            streams: [stream]
          });
          const codecs = compactVideoCodecs();
          if (codecs.length && transceiver.setCodecPreferences) {
            // CRITICAL: setCodecPreferences is an RTCRtpTransceiver method.
            // Applying the same list to every camera keeps every video m-line
            // compact while all cameras remain on this one PeerConnection.
            transceiver.setCodecPreferences(codecs);
          }
          ui.log("rx","sys",`WebRTC track added: ${label}`);
        }

        const count = state.pc.getSenders()
          .filter(s => s.track?.kind === "video").length;

        if (!count) throw Error("No active video tracks.");

        ui.status("cameraStatus", `Creating offer for ${count} camera${count === 1 ? "" : "s"}…`);

        const t = performance.now();
        const offer = await state.pc.createOffer();
        ui.log("rx","sys",`createOffer: ${(performance.now() - t).toFixed(0)} ms`);

        await state.pc.setLocalDescription(offer);
        await rtc.waitIce(state.pc);

        const local = state.pc.localDescription;
        const candidateCount = sdpStats(local?.sdp).candidates;
        if (!candidateCount)
          throw Error("ICE gathering completed but the offer contains no ICE candidates.");

        $("offerOutput").value = JSON.stringify(local);
        $("btnAcceptAnswer").disabled = false;
        const sdpBytes = sdpStats(local?.sdp).bytes;
        ui.status("cameraStatus",
          `Offer ready with ${count} camera${count === 1 ? "" : "s"}, ${candidateCount} ICE candidate${candidateCount === 1 ? "" : "s"}, ${sdpBytes} SDP bytes.`,
          "ok");
        ui.log("rx","sys",
          `Compact offer generated with ${count} video track(s), ${candidateCount} ICE candidate(s), ${sdpBytes} SDP bytes.`);
      } catch(e) {
        ui.status("cameraStatus", "Offer error: " + (e.message || e.name), "error");
        ui.log("err","sys","Offer creation failed: " + (e.message || e.name));
      } finally {
        button.disabled = false;
      }
    },

    async answer() {
      const button = $("btnAcceptAnswer");
      if (!state.pc)
        return ui.status("cameraStatus", "Create an offer first.", "error");

      if (state.pc.signalingState === "stable" &&
          state.pc.currentRemoteDescription?.type === "answer") {
        ui.status("cameraStatus", "Answer already accepted; connection is established or negotiating.", "ok");
        return;
      }

      if (state.pc.signalingState !== "have-local-offer") {
        ui.status("cameraStatus", `Cannot accept answer in state ${state.pc.signalingState}. Create a new offer.`, "error");
        return;
      }

      try {
        const answer = JSON.parse($("answerInput").value.trim());
        if (answer.type !== "answer") throw Error("The supplied SDP is not an answer.");

        button.disabled = true;
        await state.pc.setRemoteDescription(answer);

        ui.status("cameraStatus", "Answer accepted — connecting…", "ok");
        ui.log("rx","sys",
          `Answer accepted. signalingState=${state.pc.signalingState}, ` +
          `ICE=${state.pc.iceConnectionState}, connection=${state.pc.connectionState}`);

        // Report whether the answer actually contains ICE candidates.
        const sdp = answer.sdp || "";
        const candidates = (sdp.match(/^a=candidate:/gm) || []).length;
        ui.log("rx","sys",`Remote answer contains ${candidates} ICE candidate(s).`);

        // The connectionState event is the authoritative indication that the
        // manually exchanged SDP actually resulted in a working connection.
        if (state.pc.connectionState === "connected") {
          ui.status("cameraStatus", "WebRTC connected.", "ok");
        }
      } catch(e) {
        ui.status("cameraStatus", "Invalid answer code: " + e.message, "error");
        ui.log("err","sys","Invalid answer code: " + e.message);
        button.disabled = false;
      }
    },

    async acceptOffer() {
      try {
        state.pc = rtc.create();
        state.pc.ontrack = e => {
          ui.log("rx","sys",
            `Remote video track received: ${e.track.kind}, ` +
            `streams=${e.streams.length}, id=${e.track.id}`);
          viewer.addTrack(e.track, e.streams[0]);
        };
        state.pc.ondatachannel = e => {
          ui.log("rx","sys","Remote data channel received.");
          rtc.channel(e.channel);
        };

        await state.pc.setRemoteDescription(JSON.parse($("offerInput").value.trim()));
        const answer = await state.pc.createAnswer();
        await state.pc.setLocalDescription(answer);

        // Signaling is manual copy/paste, so wait for ICE gathering before
        // exposing the answer. Otherwise late candidates are lost.
        ui.status("viewerStatus", "Gathering ICE candidates…");
        await rtc.waitIce(state.pc, 10000);

        const local = state.pc.localDescription;
        $("answerOutput").value = JSON.stringify(local);

        const sdp = local?.sdp || "";
        const candidates = sdpStats(sdp).candidates;
        const sdpBytes = sdpStats(sdp).bytes;
        ui.status("viewerStatus",
          `Compact answer ready (${candidates} ICE candidates, ${sdpBytes} SDP bytes) — send it back to camera side.`,
          "ok");
        ui.log("rx","sys",
          `Answer generated. signalingState=${state.pc.signalingState}, ` +
          `ICE=${state.pc.iceGatheringState}, candidates=${candidates}, SDP=${sdpBytes} bytes.`);

      } catch(e) { ui.status("viewerStatus","Invalid offer code: " + e.message,"error"); }
    }
  };

  function chooseMode(mode) {
    state.mode = mode;
    $("modeDialog").hidden = true;
    $("app").hidden = false;
    $("app").classList.toggle("viewer-dashboard", mode === "viewer");
    $("app").classList.toggle("camera-dashboard", mode === "camera");
    const pill = $("modePill");
    pill.textContent = mode[0].toUpperCase() + mode.slice(1);
    pill.classList.add(mode);
    $(mode + "Controls").hidden = false;
    $("videoTagText").textContent = mode === "camera" ? "local preview" : "no signal";
    document.title = "Signal Relay — " + pill.textContent;
  }

  function teardown() {
    try { state.dc?.close(); } catch {}
    try { state.pc?.close(); } catch {}
    state.dc = state.pc = null;
    ui.led("ledConn","off"); ui.led("ledData","off");
    if (state.mode === "viewer") {
      // Never leave a screen recorder running across reset/mode changes.
      screenRecorder.stopAndHandle(true);
      ui.led("ledMedia","off");
      $("mainVideo").srcObject = null;
      viewer.clear();
      $("emptyHint").hidden = false;
      $("videoTagDot").classList.remove("live");
      $("videoTagText").textContent = "no signal";
      control.setEnabled(false);
      state.rxParser = null;
    }
    if (state.mode === "camera") {
      sensors.stop();
      $("chkTelemetry").checked = false;
      state.rxParser = null;
      torch.set(false);
    }
  }

  async function reset() {
    teardown();
    $("offerOutput").value = $("answerInput").value =
      $("offerInput").value = $("answerOutput").value = "";
    ui.log("err","sys","Session reset.");
  }

  async function copy(text, button) {
    try {
      await navigator.clipboard.writeText(text);
      const old = button.textContent;
      button.textContent = "Copied ✓";
      setTimeout(() => button.textContent = old,1200);
    } catch { ui.log("err","sys","Clipboard copy failed."); }
  }

  $("cardCamera").addEventListener("click", () => chooseMode("camera"));
  $("cardViewer").addEventListener("click", () => chooseMode("viewer"));
  $("btnChangeMode").onclick = () => { teardown(); location.reload(); };
  $("btnStartCamera").onclick = () => camera.start();
  $("cameraSelect").onchange = () => {};
  $("btnConnectSerial").onclick = () => serial.native();
  $("btnConnectWebUSB").onclick = () => serial.webusb();
  $("btnDisconnectSerial").onclick = () => serial.disconnect();
  $("chkTelemetry").onchange = e => sensors.toggle(e.target.checked);
  $("btnTestTorch").onclick = () => torch.set(!torch.on);
  $("btnCreateOffer").onclick = () => signaling.offer();
  $("btnAcceptAnswer").onclick = () => signaling.answer();
  $("btnLoadOffer").onclick = () => signaling.acceptOffer();

  joystick.init();
  $("btnArm").onclick = () => control.toggleArm();
  $("btnLight").onclick = () => control.toggleLight();

  $("btnCopyOffer").onclick = e => copy($("offerOutput").value,e.target);
  $("btnCopyAnswer").onclick = e => copy($("answerOutput").value,e.target);
  $("btnClearLog").onclick = () => $("logList").innerHTML = '<li class="log-empty">—</li>';
  $("btnReset").onclick = reset;

  document.addEventListener("visibilitychange", () => {
    if (state.mode !== "viewer" || state.dc?.readyState !== "open") return;
    if (document.hidden) {
      ui.log("err","sys",
        "Tab backgrounded — the browser may throttle or pause the control link " +
        "(this is a common cause of the vehicle losing signal) until it's foregrounded again.");
    } else {
      ui.log("rx","sys","Tab foregrounded — resuming control link.");
      wakeLock.acquire();
    }
  });

  window.onbeforeunload = () => {
    try { control.stopLoop(); } catch {}
    try { wakeLock.release(); } catch {}
    try { state.dc?.close(); } catch {}
    try { state.pc?.close(); } catch {}
    state.streams?.forEach(({stream}) => stream.getTracks().forEach(t => t.stop()));
    state.serial?.close();
  };
})();

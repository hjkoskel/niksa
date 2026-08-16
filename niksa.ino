/*
 * Raspberry Pi Pico CRSF -> L298N RC car controller
 *
 * CRSF input:
 *   CH1 = throttle / forward-reverse
 *   CH2 = steering
 *   CH3 = LED
 *   CH5 = ARM
 *
 * CRSF telemetry:
 *   0x08 Battery Sensor
 *
 * Serial:
 *   USB CDC Serial
 *   115200 baud, 8N1
 *
 * L298N:
 *   ENA = CHECK CODE   motor PWM
 *   IN1 = CHECK CODE  forward
 *   IN2 = CHECK CODE  reverse
 *
 *   ENB = CHECK CODE  steering PWM
 *   IN3 = CHECK CODE   left
 *   IN4 = CHECK CODE   right
 *
 * LED:
 *   GP25
 *
 * Battery ADC:
 *   GP26 / ADC0
 *
 * No external libraries.
 */

#include <Arduino.h>

// -----------------------------------------------------------------------------
// Pin configuration
// -----------------------------------------------------------------------------

constexpr uint8_t MOTOR_EN  = 13;
constexpr uint8_t MOTOR_IN1 = 14;
constexpr uint8_t MOTOR_IN2 = 15;

constexpr uint8_t STEER_EN  = 18;
constexpr uint8_t STEER_IN3 = 17;
constexpr uint8_t STEER_IN4 = 16;

constexpr uint8_t LED_PIN = 25;

constexpr uint8_t BATTERY_ADC = 26;     // ADC0

// -----------------------------------------------------------------------------
// CRSF channel assignment
//
// Array indexes are zero based:
//
// CH1 -> channels[0]
// CH2 -> channels[1]
// CH3 -> channels[2]
// CH5 -> channels[4]
// -----------------------------------------------------------------------------

constexpr uint8_t THROTTLE_CHANNEL = 0; // CH1
constexpr uint8_t STEERING_CHANNEL = 1; // CH2
constexpr uint8_t LED_CHANNEL      = 2; // CH3
constexpr uint8_t ARM_CHANNEL      = 4; // CH5

// -----------------------------------------------------------------------------
// CRSF constants
// -----------------------------------------------------------------------------

constexpr uint8_t CRSF_SYNC = 0xC8;
constexpr uint8_t CRSF_RC_CHANNELS = 0x16;
constexpr uint8_t CRSF_BATTERY_SENSOR = 0x08;

// Standard CRSF RC values.
constexpr int RC_MIN    = 172;
constexpr int RC_CENTER = 992;
constexpr int RC_MAX    = 1811;

// Arm threshold requested by user.
constexpr int ARM_THRESHOLD = 1500;

// Deadband around center.
constexpr int RC_DEADBAND = 20;

// Stop motors when no valid RC frame has been received.
constexpr uint32_t RC_TIMEOUT_MS = 500;

// Battery telemetry interval.
constexpr uint32_t BATTERY_TELEMETRY_INTERVAL_MS = 1000;

// Pico ADC is 12-bit after analogReadResolution(12).
constexpr int ADC_MAX = 4095;

// ADC reference voltage.
constexpr float ADC_REFERENCE = 3.3f;

// Set this to the voltage-divider ratio.
//
// Example:
//
//   100k / 10k divider:
//   ratio = (100k + 10k) / 10k = 11.0
//
// If GP26 measures the battery voltage directly, use 1.0.
constexpr float BATTERY_DIVIDER_RATIO = 5.5f;

// -----------------------------------------------------------------------------
// Global state
// -----------------------------------------------------------------------------

uint16_t channels[16];

uint32_t lastRcFrame = 0;
uint32_t lastBatteryTelemetry = 0;

bool armed = false;

// -----------------------------------------------------------------------------
// CRSF CRC8 DVB-S2
//
// Polynomial: 0xD5
// CRC covers TYPE + PAYLOAD.
// It does NOT include sync or length.
// -----------------------------------------------------------------------------

uint8_t crsfCrc8(const uint8_t *data, uint8_t length)
{
    uint8_t crc = 0;

    while (length--) {
        crc ^= *data++;

        for (uint8_t i = 0; i < 8; i++) {
            if (crc & 0x80)
                crc = (crc << 1) ^ 0xD5;
            else
                crc <<= 1;
        }
    }

    return crc;
}

// -----------------------------------------------------------------------------
// CRSF frame receiver
//
// Frame:
//
//   SYNC
//   LENGTH
//   TYPE
//   PAYLOAD...
//   CRC
// -----------------------------------------------------------------------------

class CrsfReceiver
{
public:
    void process()
    {
        while (Serial.available()) {
            uint8_t byte = Serial.read();
            receiveByte(byte);
        }
    }

private:
    uint8_t buffer[64];
    uint8_t index = 0;
    uint8_t frameLength = 0;

    enum State {
        WAIT_SYNC,
        WAIT_LENGTH,
        RECEIVE_FRAME
    };

    State state = WAIT_SYNC;

    void receiveByte(uint8_t byte)
    {
        switch (state) {

        case WAIT_SYNC:
            if (isValidSync(byte)) {
                buffer[0] = byte;
                index = 1;
                state = WAIT_LENGTH;
            }
            break;

        case WAIT_LENGTH:
            frameLength = byte;

            // CRSF length is number of bytes after LENGTH:
            // TYPE + PAYLOAD + CRC
            //
            // Valid range according to specification: 2..62.
            if (frameLength < 2 || frameLength > 62) {
                state = WAIT_SYNC;
                return;
            }

            buffer[index++] = byte;

            // Total bytes after SYNC and LENGTH.
            state = RECEIVE_FRAME;
            break;

        case RECEIVE_FRAME:
            buffer[index++] = byte;

            if (index >= (uint8_t)(frameLength + 2)) {
                processFrame();

                // Immediately search for next frame.
                state = WAIT_SYNC;
                index = 0;
            }

            break;
        }
    }

    bool isValidSync(uint8_t byte)
    {
        /*
         * CRSF permits serial sync 0xC8 and device addresses as
         * synchronization bytes.
         *
         * For this application 0xC8 is the normal incoming value,
         * but accepting the other addresses makes the parser more
         * tolerant.
         */

        switch (byte) {
        case 0xC8:
        case 0x00:
        case 0xEA:
        case 0xEC:
        case 0xEE:
            return true;

        default:
            return false;
        }
    }

    void processFrame()
    {
        // buffer:
        //
        // [0]       sync
        // [1]       length
        // [2]       type
        // [3..]     payload
        // [last]    CRC

        uint8_t type = buffer[2];

        uint8_t crcReceived = buffer[index - 1];

        // CRC starts at TYPE and includes all payload bytes.
        uint8_t crcCalculated =
            crsfCrc8(&buffer[2], frameLength - 1);

        if (crcCalculated != crcReceived)
            return;

        if (type == CRSF_RC_CHANNELS)
            processRcChannels();
    }

    void processRcChannels()
    {
        // 0x16 contains 16 channels x 11 bits = 176 bits = 22 bytes.
        //
        // Normal frame:
        //
        // SYNC   1
        // LENGTH 1
        // TYPE   1
        // DATA  22
        // CRC    1
        //
        // LENGTH = 24.

        if (frameLength < 24)
            return;

        const uint8_t *p = &buffer[3];

        uint32_t bitBuffer = 0;
        uint8_t bits = 0;

        uint8_t channel = 0;

        for (uint8_t i = 0; i < 22 && channel < 16; i++) {

            bitBuffer |= ((uint32_t)p[i]) << bits;
            bits += 8;

            while (bits >= 11 && channel < 16) {

                channels[channel] = bitBuffer & 0x7FF;

                bitBuffer >>= 11;
                bits -= 11;

                channel++;
            }
        }

        lastRcFrame = millis();

        updateController();
    }

    void updateController()
    {
        // -----------------------------------------------------------------
        // ARM
        // -----------------------------------------------------------------

        armed = channels[ARM_CHANNEL] > ARM_THRESHOLD;

        // -----------------------------------------------------------------
        // LED
        // -----------------------------------------------------------------

        digitalWrite(
            LED_PIN,
            channels[LED_CHANNEL] > 1500 ? HIGH : LOW
        );

        // -----------------------------------------------------------------
        // Motors
        // -----------------------------------------------------------------

        if (!armed) {
            stopMotors();
            return;
        }

        int throttle = rcToSigned(channels[THROTTLE_CHANNEL]);
        int steering = rcToSigned(channels[STEERING_CHANNEL]);

        driveMotor(
            MOTOR_EN,
            MOTOR_IN1,
            MOTOR_IN2,
            throttle
        );

        driveMotor(
            STEER_EN,
            STEER_IN3,
            STEER_IN4,
            steering
        );
    }

    int rcToSigned(uint16_t value)
    {
        int v = (int)value - RC_CENTER;

        if (abs(v) <= RC_DEADBAND)
            return 0;

        if (v > 0) {
            v -= RC_DEADBAND;

            int range = RC_MAX - RC_CENTER - RC_DEADBAND;

            if (range <= 0)
                return 0;

            v = (v * 255) / range;
        }
        else {
            v += RC_DEADBAND;

            int range = RC_CENTER - RC_MIN - RC_DEADBAND;

            if (range <= 0)
                return 0;

            v = (v * 255) / range;
        }

        return constrain(v, -255, 255);
    }

    void driveMotor(
        uint8_t en,
        uint8_t inA,
        uint8_t inB,
        int value
    )
    {
        if (value > 0) {

            digitalWrite(inA, HIGH);
            digitalWrite(inB, LOW);

            analogWrite(en, value);
        }
        else if (value < 0) {

            digitalWrite(inA, LOW);
            digitalWrite(inB, HIGH);

            analogWrite(en, -value);
        }
        else {

            analogWrite(en, 0);

            digitalWrite(inA, LOW);
            digitalWrite(inB, LOW);
        }
    }

    void stopMotors()
    {
        analogWrite(MOTOR_EN, 0);
        analogWrite(STEER_EN, 0);

        digitalWrite(MOTOR_IN1, LOW);
        digitalWrite(MOTOR_IN2, LOW);

        digitalWrite(STEER_IN3, LOW);
        digitalWrite(STEER_IN4, LOW);
    }
};

CrsfReceiver crsf;

// -----------------------------------------------------------------------------
// Battery voltage
// -----------------------------------------------------------------------------

float readBatteryVoltage()
{
    /*
     * Use the full 12-bit ADC range.

     * raw = 0..4095
     * ADC voltage = raw / 4095 * 3.3V
     * battery voltage = ADC voltage * divider ratio
     */

    uint32_t sum = 0;

    // A small average reduces ADC noise without significantly delaying
    // the controller.
    for (int i = 0; i < 8; i++)
        sum += analogRead(BATTERY_ADC);

    float raw = sum / 8.0f;

    float adcVoltage =
        raw * ADC_REFERENCE / ADC_MAX;

    return adcVoltage * BATTERY_DIVIDER_RATIO;
}

// -----------------------------------------------------------------------------
// Send CRSF Battery Sensor frame
//
// Frame:
//
// C8 08 08 VV VV CC CC MM MM MM RR CRC
//
// LEN = 8
// TYPE = 0x08
//
// Voltage: 16-bit, 0.01V/LSB
// Current: 16-bit, 0.01A/LSB
// Capacity: 24-bit mAh
// Remaining: percentage
//
// We only measure voltage, so the other fields are zero.
// -----------------------------------------------------------------------------

void sendBatteryTelemetry()
{
    float voltage = readBatteryVoltage();

    /*
     * Existing CRSF implementations represent battery voltage as
     * 100 units per volt:
     *
     *   12.34 V -> 1234
     *
     * This fits the normal RC battery voltage range into uint16_t.
     */

    uint16_t voltageValue =
        (uint16_t)constrain(
            (int)(voltage * 100.0f + 0.5f),
            0,
            65535
        );

    uint8_t frame[12];

    frame[0] = CRSF_SYNC;
    // Per CRSF spec, LENGTH = TYPE + PAYLOAD + CRC = 1 + 8 + 1 = 10.
    // (Previously hardcoded to 8 here, which under-reported the frame
    // by 2 bytes — the payload-only size, not TYPE+PAYLOAD+CRC. The
    // browser-side parser had a special case to work around this; that
    // workaround has been removed now that this is spec-correct.)
    frame[1] = 10;
    frame[2] = CRSF_BATTERY_SENSOR;

    // Voltage, big endian.
    frame[3] = voltageValue >> 8;
    frame[4] = voltageValue & 0xFF;

    // Current = 0.
    frame[5] = 0;
    frame[6] = 0;

    // Capacity used = 0.
    frame[7] = 0;
    frame[8] = 0;
    frame[9] = 0;

    // Remaining percentage unknown.
    frame[10] = 0;

    // CRC includes TYPE through payload.
    frame[11] =
        crsfCrc8(&frame[2], 9);

    // Non-blocking send.
    //
    // Serial.write() on USB CDC blocks until there is room in the TX
    // buffer. If the host stops reading (app not polling, port closed,
    // USB hiccup) that write can block forever, which freezes loop()
    // and with it crsf.process() and the RC failsafe. So: only write
    // when we know it won't block, otherwise drop this telemetry frame
    // and try again next interval.
    if ((size_t)Serial.availableForWrite() >= sizeof(frame)) {
        Serial.write(frame, sizeof(frame));
    }
}

// -----------------------------------------------------------------------------
// Setup
// -----------------------------------------------------------------------------

void setup()
{
    // USB CRSF serial.
    Serial.begin(115200);

    // L298N.
    pinMode(MOTOR_EN, OUTPUT);
    pinMode(MOTOR_IN1, OUTPUT);
    pinMode(MOTOR_IN2, OUTPUT);

    pinMode(STEER_EN, OUTPUT);
    pinMode(STEER_IN3, OUTPUT);
    pinMode(STEER_IN4, OUTPUT);

    //avoid burning drive with too high frequency
    analogWriteFreq(1000);

    // LED.
    pinMode(LED_PIN, OUTPUT);

    // Battery ADC.
    pinMode(BATTERY_ADC, INPUT);

    // Use the complete RP2040 ADC resolution.
    analogReadResolution(12);

    // PWM is 8-bit: 0..255.
    analogWriteResolution(8);

    // Safe initial state.
    digitalWrite(LED_PIN, LOW);

    analogWrite(MOTOR_EN, 0);
    analogWrite(STEER_EN, 0);

    digitalWrite(MOTOR_IN1, LOW);
    digitalWrite(MOTOR_IN2, LOW);

    digitalWrite(STEER_IN3, LOW);
    digitalWrite(STEER_IN4, LOW);

    for (int i = 0; i < 16; i++)
        channels[i] = RC_CENTER;

    lastRcFrame = millis();
    lastBatteryTelemetry = millis();

    // Hardware watchdog: if loop() ever stalls (e.g. a blocking call
    // that doesn't return) for more than 2 seconds, force a reset
    // instead of requiring a manual power cycle / USB replug.
    rp2040.wdt_begin(2000);
}

// -----------------------------------------------------------------------------
// Main loop
// -----------------------------------------------------------------------------

void loop()
{
    // Feed the watchdog. If loop() ever fails to come back around
    // within its timeout, the chip resets itself.
    rp2040.wdt_reset();

    // Process all incoming CRSF frames.
    crsf.process();

    uint32_t now = millis();

    // -------------------------------------------------------------------------
    // Failsafe
    // -------------------------------------------------------------------------

    if (now - lastRcFrame > RC_TIMEOUT_MS) {

        armed = false;

        analogWrite(MOTOR_EN, 0);
        analogWrite(STEER_EN, 0);

        digitalWrite(MOTOR_IN1, LOW);
        digitalWrite(MOTOR_IN2, LOW);

        digitalWrite(STEER_IN3, LOW);
        digitalWrite(STEER_IN4, LOW);

        digitalWrite(LED_PIN, LOW);
    }

    // -------------------------------------------------------------------------
    // Battery telemetry
    // -------------------------------------------------------------------------

    if (now - lastBatteryTelemetry >=
        BATTERY_TELEMETRY_INTERVAL_MS) {

        lastBatteryTelemetry = now;

        sendBatteryTelemetry();
    }
}
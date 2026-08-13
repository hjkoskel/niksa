# serve_https.py
import http.server, ssl

httpd = http.server.HTTPServer(("0.0.0.0", 4443), http.server.SimpleHTTPRequestHandler)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain("cert.pem", "key.pem")
httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)

print("Serving https://0.0.0.0:4443")
httpd.serve_forever()

# HTTPX proxy credential flow

`Proxy.__init__` in `httpx/_config.py` parses the input as a `URL`. When the URL has a username or password it stores decoded string credentials in `self.auth`, then calls `URL.copy_with(username=None, password=None)` so `self.url` no longer carries userinfo.

The `Proxy.raw_auth` property in `httpx/_config.py` UTF-8 encodes the stored pair. `HTTPTransport.__init__` and `AsyncHTTPTransport.__init__` in `httpx/_transports/default.py` pass that byte pair to HTTP Core as `proxy_auth=proxy.raw_auth` for both HTTP and SOCKS proxy pools.

There are two representation boundaries. `URL.__repr__` masks a password-bearing userinfo component as `[secure]`. `Proxy.__repr__` renders the already-scrubbed URL and, if auth exists, substitutes `********` for the stored password. `str(URL)` is not a secrecy boundary by itself; removing credentials from `Proxy.url` is therefore important before it reaches transport configuration or ordinary proxy representation.

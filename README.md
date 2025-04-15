# tunnel-new

tunnel-new is a fork of localtunnel that segregates tunnels by IP address. If person A at 0.0.0.0 opens a tunnel to site A at a.tunnel.new, it can only be accessed by users at 0.0.0.0. If person B at 1.1.1.1 opens a tunnel to site B at b.tunnel.new, it can only be accessed by users at 1.1.1.1. Users at 0.0.0.0 will not be able to access site B, and users at 1.1.1.1 will not be able to access site A. Users at 2.2.2.2 won't be able to access either site.

## Quickstart

```
npx tunnel-new --port 8000
```

## Installation

### Globally

```
npm install -g tunnel-new
```

### As a dependency in your project

```
yarn add tunnel-new
```

## CLI usage

When tunnel-new is installed globally, just use the `tunnel-new` command to start the tunnel.

```
tunnel-new --port 8000
```

Thats it! It will connect to the tunnel server, setup the tunnel, and tell you what url to use for your testing. This url will remain active for the duration of your session; so feel free to share it with others for happy fun time!

You can restart your local server all you want, `tunnel-new` is smart enough to detect this and reconnect once it is back.

### Arguments

Below are some common arguments. See `tunnel-new --help` for additional arguments

- `--subdomain` request a named subdomain on the tunnel-new server (default is random characters)
- `--local-host` proxy to a hostname other than localhost

You may also specify arguments via env variables. E.x.

```
PORT=3000 tunnel-new
```

## API

The tunnel-new client is also usable through an API (for test integration, automation, etc)

### tunnelNew(port [,options][,callback])

Creates a new tunnel-new to the specified local `port`. Will return a Promise that resolves once you have been assigned a public tunnel-new url. `options` can be used to request a specific `subdomain`. A `callback` function can be passed, in which case it won't return a Promise. This exists for backwards compatibility with the old Node-style callback API. You may also pass a single options object with `port` as a property.

```js
const tunnelNew = require('tunnel-new');

(async () => {
  const tunnel = await tunnelNew({ port: 3000 });

  // the assigned public url for your tunnel
  // i.e. https://abcdefgjhij.tunnel.new
  tunnel.url;

  tunnel.on('close', () => {
    // tunnels are closed
  });
})();
```

#### options

- `port` (number) [required] The local port number to expose through tunnel-new.
- `subdomain` (string) Request a specific subdomain on the proxy server. **Note** You may not actually receive this name depending on availability.
- `host` (string) URL for the upstream proxy server. Defaults to `https://tunnel.new`.
- `local_host` (string) Proxy to this hostname instead of `localhost`. This will also cause the `Host` header to be re-written to this value in proxied requests.
- `local_https` (boolean) Enable tunneling to local HTTPS server.
- `local_cert` (string) Path to certificate PEM file for local HTTPS server.
- `local_key` (string) Path to certificate key file for local HTTPS server.
- `local_ca` (string) Path to certificate authority file for self-signed certificates.
- `allow_invalid_cert` (boolean) Disable certificate checks for your local HTTPS server (ignore cert/key/ca options).

Refer to [tls.createSecureContext](https://nodejs.org/api/tls.html#tls_tls_createsecurecontext_options) for details on the certificate options.

### Tunnel

The `tunnel` instance returned to your callback emits the following events

| event   | args | description                                                                          |
| ------- | ---- | ------------------------------------------------------------------------------------ |
| request | info | fires when a request is processed by the tunnel, contains _method_ and _path_ fields |
| error   | err  | fires when an error happens on the tunnel                                            |
| close   |      | fires when the tunnel has closed                                                     |

The `tunnel` instance has the following methods

| method | args | description      |
| ------ | ---- | ---------------- |
| close  |      | close the tunnel |

## License

MIT

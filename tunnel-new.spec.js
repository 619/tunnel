/* eslint-disable no-console */

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const url = require('url');
const assert = require('assert');

const tunnelNew = require('./tunnel-new');

let fakePort;

before(done => {
  const server = http.createServer();
  server.on('request', (req, res) => {
    res.write(req.headers.host);
    res.end();
  });
  server.listen(() => {
    const { port } = server.address();
    fakePort = port;
    done();
  });
});

it('query tunnel-new server w/ ident', async done => {
  const tunnel = await tunnelNew({ port: fakePort });
  assert.ok(new RegExp('^https://.*tunnel.new$').test(tunnel.url));

  const parsed = url.parse(tunnel.url);
  const opt = {
    host: parsed.host,
    port: 443,
    headers: { host: parsed.hostname },
    path: '/',
  };

  const req = https.request(opt, res => {
    res.setEncoding('utf8');
    let body = '';

    res.on('data', chunk => {
      body += chunk;
    });

    res.on('end', () => {
      assert(/.*[.]tunnel[.]new/.test(body), body);
      tunnel.close();
      done();
    });
  });

  req.end();
});

it('request specific domain', async () => {
  const subdomain = Math.random()
    .toString(36)
    .substr(2);
  const tunnel = await tunnelNew({ port: fakePort, subdomain });
  assert.ok(new RegExp(`^https://${subdomain}.tunnel.new$`).test(tunnel.url));
  tunnel.close();
});

describe('--local-host localhost', () => {
  it('override Host header with local-host', async done => {
    const tunnel = await tunnelNew({ port: fakePort, local_host: 'localhost' });
    assert.ok(new RegExp('^https://.*tunnel.new$').test(tunnel.url));

    const parsed = url.parse(tunnel.url);
    const opt = {
      host: parsed.host,
      port: 443,
      headers: { host: parsed.hostname },
      path: '/',
    };

    const req = https.request(opt, res => {
      res.setEncoding('utf8');
      let body = '';

      res.on('data', chunk => {
        body += chunk;
      });

      res.on('end', () => {
        assert.strictEqual(body, 'localhost');
        tunnel.close();
        done();
      });
    });

    req.end();
  });
});

describe('--local-host 127.0.0.1', () => {
  it('override Host header with local-host', async done => {
    const tunnel = await tunnelNew({ port: fakePort, local_host: '127.0.0.1' });
    assert.ok(new RegExp('^https://.*tunnel.new$').test(tunnel.url));

    const parsed = url.parse(tunnel.url);
    const opt = {
      host: parsed.host,
      port: 443,
      headers: {
        host: parsed.hostname,
      },
      path: '/',
    };

    const req = https.request(opt, res => {
      res.setEncoding('utf8');
      let body = '';

      res.on('data', chunk => {
        body += chunk;
      });

      res.on('end', () => {
        assert.strictEqual(body, '127.0.0.1');
        tunnel.close();
        done();
      });
    });

    req.end();
  });

  it('send chunked request', async done => {
    const tunnel = await tunnelNew({ port: fakePort, local_host: '127.0.0.1' });
    assert.ok(new RegExp('^https://.*tunnel.new$').test(tunnel.url));

    const parsed = url.parse(tunnel.url);
    const opt = {
      host: parsed.host,
      port: 443,
      headers: {
        host: parsed.hostname,
        'Transfer-Encoding': 'chunked',
      },
      path: '/',
    };

    const req = https.request(opt, res => {
      res.setEncoding('utf8');
      let body = '';

      res.on('data', chunk => {
        body += chunk;
      });

      res.on('end', () => {
        assert.strictEqual(body, '127.0.0.1');
        tunnel.close();
        done();
      });
    });

    req.end(crypto.randomBytes(1024 * 8).toString('base64'));
  });
});

describe('subdomain conflict handling', () => {
  it('should handle 409 conflict errors properly', async () => {
    // Mock axios to simulate a 409 conflict response
    const originalAxios = require('axios');
    const mockAxios = {
      get: (uri, params) => {
        if (uri.includes('conflict-subdomain')) {
          // Simulate a 409 conflict response
          const error = new Error('Conflict');
          error.response = {
            status: 409,
            data: {
              message: 'The tunnel conflict-subdomain is already in use by your IP address. Please choose a different subdomain.'
            }
          };
          return Promise.reject(error);
        }
        return originalAxios.get(uri, params);
      }
    };
    
    // Replace axios with our mock
    const Tunnel = require('./lib/Tunnel');
    const originalRequire = require;
    require = function(name) {
      if (name === 'axios') {
        return mockAxios;
      }
      return originalRequire(name);
    };
    
    try {
      // Try to create a tunnel with a conflicting subdomain
      await tunnelNew({ 
        port: fakePort, 
        subdomain: 'conflict-subdomain' 
      });
      
      // If we get here, the test failed
      assert.fail('Expected an error but none was thrown');
    } catch (err) {
      // Verify the error has the expected code and message
      assert.strictEqual(err.code, 'ESUBDOMAINCONFLICT');
      assert.ok(err.message.includes('already in use by your IP address'));
    } finally {
      // Restore the original require function
      require = originalRequire;
    }
  });
});

describe('IP change handling', () => {
  let originalAxios;
  let mockAxios;
  let originalRequire;
  
  beforeEach(() => {
    // Save the original axios module
    originalAxios = require('axios');
    
    // Create a mock axios module
    mockAxios = {
      get: (uri) => {
        if (uri.endsWith('/api/ip')) {
          return Promise.resolve({ data: { ip: '1.2.3.4' } });
        }
        return originalAxios.get(uri);
      },
      post: (uri, data) => {
        if (uri.includes('/api/tunnels/') && uri.endsWith('/ip-change')) {
          // Simulate successful IP change
          return Promise.resolve({ 
            status: 200, 
            data: { 
              success: true,
              message: 'IP address updated successfully'
            } 
          });
        }
        return originalAxios.post(uri, data);
      }
    };
    
    // Replace axios with our mock
    originalRequire = require;
    require = function(name) {
      if (name === 'axios') {
        return mockAxios;
      }
      return originalRequire(name);
    };
  });
  
  afterEach(() => {
    // Restore the original require function
    require = originalRequire;
  });
  
  it('should detect and handle IP changes', async () => {
    // Create a tunnel with IP change detection enabled
    const tunnel = await tunnelNew({ 
      port: fakePort,
      detectIpChanges: true
    });
    
    // Verify the tunnel is created successfully
    assert.ok(tunnel.url);
    assert.strictEqual(tunnel.currentIp, '1.2.3.4');
    
    // Simulate an IP change
    let ipChangeEventReceived = false;
    
    tunnel.on('ip-change', (event) => {
      ipChangeEventReceived = true;
      assert.strictEqual(event.oldIp, '1.2.3.4');
      assert.strictEqual(event.newIp, '5.6.7.8');
      assert.strictEqual(event.success, true);
    });
    
    // Change the IP returned by the mock
    mockAxios.get = (uri) => {
      if (uri.endsWith('/api/ip')) {
        return Promise.resolve({ data: { ip: '5.6.7.8' } });
      }
      return originalAxios.get(uri);
    };
    
    // Manually trigger IP check
    await tunnel._getCurrentIp();
    await tunnel._notifyIpChange('1.2.3.4', '5.6.7.8');
    
    // Verify the IP change event was emitted
    assert.strictEqual(ipChangeEventReceived, true);
    
    // Verify the current IP was updated
    assert.strictEqual(tunnel.currentIp, '5.6.7.8');
    
    tunnel.close();
  });
  
  it('should handle IP change errors', async () => {
    // Create a tunnel with IP change detection enabled
    const tunnel = await tunnelNew({ 
      port: fakePort,
      detectIpChanges: true
    });
    
    // Verify the tunnel is created successfully
    assert.ok(tunnel.url);
    
    // Simulate an IP change error (404 Not Found)
    let ipChangeErrorReceived = false;
    
    tunnel.on('ip-change', (event) => {
      ipChangeErrorReceived = true;
      assert.strictEqual(event.oldIp, '1.2.3.4');
      assert.strictEqual(event.newIp, '5.6.7.8');
      assert.strictEqual(event.success, false);
      assert.strictEqual(event.error.code, 'ETUNNELEXPIRED');
    });
    
    // Mock the axios post to return an error
    mockAxios.post = (uri, data) => {
      if (uri.includes('/api/tunnels/') && uri.endsWith('/ip-change')) {
        const error = new Error('Tunnel not found');
        error.response = {
          status: 404,
          data: { 
            error: 'Tunnel not found',
            message: `No tunnel exists with ID ${tunnel.clientId}`
          }
        };
        return Promise.reject(error);
      }
      return originalAxios.post(uri, data);
    };
    
    // Manually trigger IP change notification
    await tunnel._notifyIpChange('1.2.3.4', '5.6.7.8');
    
    // Verify the IP change error event was emitted
    assert.strictEqual(ipChangeErrorReceived, true);
    
    // Verify the current IP was not updated
    assert.strictEqual(tunnel.currentIp, '1.2.3.4');
    
    tunnel.close();
  });
});

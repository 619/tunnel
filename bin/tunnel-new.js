#!/usr/bin/env node
/* eslint-disable no-console */

const openurl = require('openurl');
const yargs = require('yargs');

const tunnelNew = require('../tunnel-new');
const { version } = require('../package');

const { argv } = yargs
  .usage('Usage: tunnel-new --port [num] <options>')
  .env(true)
  .option('p', {
    alias: 'port',
    describe: 'Internal HTTP server port',
  })
  .option('h', {
    alias: 'host',
    describe: 'Upstream server providing forwarding',
    default: 'https://tunnel.new',
  })
  .option('s', {
    alias: 'subdomain',
    describe: 'Request this subdomain',
  })
  .option('l', {
    alias: 'local-host',
    describe: 'Tunnel traffic to this host instead of localhost, override Host header to this host',
  })
  .option('local-https', {
    describe: 'Tunnel traffic to a local HTTPS server',
  })
  .option('local-cert', {
    describe: 'Path to certificate PEM file for local HTTPS server',
  })
  .option('local-key', {
    describe: 'Path to certificate key file for local HTTPS server',
  })
  .option('local-ca', {
    describe: 'Path to certificate authority file for self-signed certificates',
  })
  .option('allow-invalid-cert', {
    describe: 'Disable certificate checks for your local HTTPS server (ignore cert/key/ca options)',
  })
  .options('o', {
    alias: 'open',
    describe: 'Opens the tunnel URL in your browser',
  })
  .option('print-requests', {
    describe: 'Print basic request info',
  })
  .option('detect-ip-changes', {
    describe: 'Automatically detect and handle IP address changes',
    default: true,
    type: 'boolean',
  })
  .option('auto-reconnect', {
    describe: 'Automatically reconnect when tunnel connection is lost',
    default: true,
    type: 'boolean',
  })
  .option('check-ip-interval', {
    describe: 'Interval in seconds to check for IP changes (minimum 5)',
    default: 15,
    type: 'number',
  })
  .option('monitor-network', {
    describe: 'Actively monitor for network changes to detect IP changes immediately',
    default: true,
    type: 'boolean',
  })
  .require('port')
  .boolean('local-https')
  .boolean('allow-invalid-cert')
  .boolean('print-requests')
  .boolean('detect-ip-changes')
  .boolean('auto-reconnect')
  .boolean('monitor-network')
  .help('help', 'Show this help and exit')
  .version(version);

if (typeof argv.port !== 'number') {
  yargs.showHelp();
  console.error('\nInvalid argument: `port` must be a number');
  process.exit(1);
}

(async () => {
  let tunnel;
  let reconnectAttempts = 0;
  const MAX_RECONNECT_ATTEMPTS = 5;
  const RECONNECT_DELAY = 2000; // 2 seconds
  
  async function createTunnel(options = {}) {
    try {
      const checkIpInterval = Math.max(5, argv.checkIpInterval); // Minimum 5 seconds
      
      const tunnelOptions = {
        port: argv.port,
        host: argv.host,
        subdomain: argv.subdomain,
        local_host: argv.localHost,
        local_https: argv.localHttps,
        local_cert: argv.localCert,
        local_key: argv.localKey,
        local_ca: argv.localCa,
        allow_invalid_cert: argv.allowInvalidCert,
        detectIpChanges: argv.detectIpChanges,
        monitorNetwork: argv.monitorNetwork,
        checkIpInterval: checkIpInterval * 1000, // Convert to milliseconds
        ...options,
      };
      
      tunnel = await tunnelNew(tunnelOptions);
      
      // Reset reconnect attempts on successful connection
      reconnectAttempts = 0;
      
      // Setup event listeners
      setupTunnelListeners(tunnel);
      
      console.log('your url is: %s', tunnel.url);
      
      if (tunnel.cachedUrl) {
        console.log('your cachedUrl is: %s', tunnel.cachedUrl);
      }
      
      if (argv.open) {
        openurl.open(tunnel.url);
      }
      
      if (argv['print-requests']) {
        tunnel.on('request', info => {
          console.log(new Date().toString(), info.method, info.path);
        });
      }
      
      // Setup keyboard shortcuts for manual IP check
      if (argv.detectIpChanges) {
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on('data', (key) => {
          // Ctrl+I to manually check IP
          if (key.length === 1 && key[0] === 9) { // ASCII code 9 is Tab (Ctrl+I)
            console.log('\nManually checking for IP changes...');
            tunnel._checkForIpChange().then(() => {
              console.log('IP check completed');
            }).catch(err => {
              console.error(`IP check failed: ${err.message}`);
            });
          }
          
          // Ctrl+C to exit
          if (key.length === 1 && key[0] === 3) {
            if (tunnel) {
              tunnel.close();
            }
            process.exit();
          }
        });
        
        console.log('\nPress Ctrl+I to manually check for IP changes');
        console.log('Press Ctrl+C to exit');
      }
      
      return tunnel;
    } catch (err) {
      handleTunnelError(err);
      throw err;
    }
  }
  
  function setupTunnelListeners(tunnelInstance) {
    // Handle IP change events
    tunnelInstance.on('ip-change', event => {
      if (event.success) {
        console.log(`\nIP address changed from ${event.oldIp} to ${event.newIp}`);
        console.log('Tunnel connection maintained successfully');
      } else {
        console.error(`\nIP address changed from ${event.oldIp} to ${event.newIp}`);
        console.error(`Error: ${event.error.message}`);
        
        // If auto-reconnect is enabled, try to create a new tunnel
        if (argv.autoReconnect) {
          attemptReconnect();
        } else {
          console.error('Use --auto-reconnect to automatically create a new tunnel when IP changes fail');
        }
      }
    });
    
    // Handle general errors
    tunnelInstance.on('error', err => {
      if (err.code === 'ETUNNELEXPIRED' || err.code === 'EIPMISMATCH' || err.code === 'ETUNNELCONFLICT') {
        // These errors are already handled by the ip-change event
        return;
      }
      
      console.error(`\nTunnel error: ${err.message}`);
      
      // If auto-reconnect is enabled, try to create a new tunnel
      if (argv.autoReconnect) {
        attemptReconnect();
      } else {
        throw err;
      }
    });
  }
  
  async function attemptReconnect() {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error(`\nFailed to reconnect after ${MAX_RECONNECT_ATTEMPTS} attempts`);
      process.exit(1);
      return;
    }
    
    reconnectAttempts++;
    
    console.log(`\nAttempting to reconnect (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
    
    // Wait before attempting to reconnect
    await new Promise(resolve => setTimeout(resolve, RECONNECT_DELAY));
    
    try {
      // Close the existing tunnel if it's still open
      if (tunnel && !tunnel.closed) {
        tunnel.close();
      }
      
      // Try to create a new tunnel with the same options
      await createTunnel();
      console.log('Successfully reconnected!');
    } catch (err) {
      console.error(`Reconnect attempt failed: ${err.message}`);
      attemptReconnect();
    }
  }
  
  function handleTunnelError(err) {
    if (err.code === 'ESUBDOMAINCONFLICT') {
      console.error(`\nError: ${err.message}`);
      console.error('Please try again with a different subdomain using the -s option.');
      process.exit(1);
    } else {
      console.error(`\nError: ${err.message}`);
      process.exit(1);
    }
  }
  
  try {
    await createTunnel();
  } catch (err) {
    // Error is already handled in createTunnel
  }
})();

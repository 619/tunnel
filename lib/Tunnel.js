/* eslint-disable consistent-return, no-underscore-dangle */

const { parse } = require('url');
const { EventEmitter } = require('events');
const axios = require('axios');
const debug = require('debug')('tunnel-new:client');

const TunnelCluster = require('./TunnelCluster');

module.exports = class Tunnel extends EventEmitter {
  constructor(opts = {}) {
    super(opts);
    this.opts = opts;
    this.closed = false;
    this.currentIp = null;
    this.ipCheckInterval = null;
    if (!this.opts.host) {
      this.opts.host = 'https://tunnel.new';
    }
  }

  _getInfo(body) {
    /* eslint-disable camelcase */
    const { id, ip, port, url, cached_url, max_conn_count } = body;
    const { host, port: local_port, local_host } = this.opts;
    const { local_https, local_cert, local_key, local_ca, allow_invalid_cert } = this.opts;
    
    // Store the initial IP address
    this.currentIp = ip;
    
    return {
      name: id,
      url,
      cached_url,
      max_conn: max_conn_count || 1,
      remote_host: parse(host).hostname,
      remote_ip: ip,
      remote_port: port,
      local_port,
      local_host,
      local_https,
      local_cert,
      local_key,
      local_ca,
      allow_invalid_cert,
    };
    /* eslint-enable camelcase */
  }

  // initialize connection
  // callback with connection info
  _init(cb) {
    const opt = this.opts;
    const getInfo = this._getInfo.bind(this);

    const params = {
      responseType: 'json',
    };

    const baseUri = `${opt.host}/`;
    // no subdomain at first, maybe use requested domain
    const assignedDomain = opt.subdomain;
    // where to quest
    const uri = baseUri + (assignedDomain || '?new');

    (function getUrl() {
      axios
        .get(uri, params)
        .then(res => {
          const body = res.data;
          debug('got tunnel information', res.data);
          if (res.status === 409) {
            // Special case for subdomain already in use by same IP
            const err = new Error(
              (body && body.message) || 'The requested subdomain is already in use by your IP address. Please choose a different subdomain.'
            );
            err.code = 'ESUBDOMAINCONFLICT';
            return cb(err);
          } else if (res.status !== 200) {
            const err = new Error(
              (body && body.message) || 'tunnel server returned an error, please try again'
            );
            return cb(err);
          }
          cb(null, getInfo(body));
        })
        .catch(err => {
          // Check if the error is a 409 conflict response
          if (err.response && err.response.status === 409) {
            const body = err.response.data;
            const conflictErr = new Error(
              (body && body.message) || 'The requested subdomain is already in use by your IP address. Please choose a different subdomain.'
            );
            conflictErr.code = 'ESUBDOMAINCONFLICT';
            return cb(conflictErr);
          }
          debug(`tunnel server offline: ${err.message}, retry 1s`);
          return setTimeout(getUrl, 1000);
        });
    })();
  }

  _establish(info) {
    // increase max event listeners so that tunnel-new consumers don't get
    // warning messages as soon as they setup even one listener. See #71
    this.setMaxListeners(info.max_conn + (EventEmitter.defaultMaxListeners || 10));

    this.tunnelCluster = new TunnelCluster(info);

    // only emit the url the first time
    this.tunnelCluster.once('open', () => {
      this.emit('url', info.url);
    });

    // re-emit socket error
    this.tunnelCluster.on('error', err => {
      debug('got socket error', err.message);
      this.emit('error', err);
    });

    let tunnelCount = 0;

    // track open count
    this.tunnelCluster.on('open', tunnel => {
      tunnelCount++;
      debug('tunnel open [total: %d]', tunnelCount);

      const closeHandler = () => {
        tunnel.destroy();
      };

      if (this.closed) {
        return closeHandler();
      }

      this.once('close', closeHandler);
      tunnel.once('close', () => {
        this.removeListener('close', closeHandler);
      });
    });

    // when a tunnel dies, open a new one
    this.tunnelCluster.on('dead', () => {
      tunnelCount--;
      debug('tunnel dead [total: %d]', tunnelCount);
      if (this.closed) {
        return;
      }
      this.tunnelCluster.open();
    });

    this.tunnelCluster.on('request', req => {
      this.emit('request', req);
    });

    // establish as many tunnels as allowed
    for (let count = 0; count < info.max_conn; ++count) {
      this.tunnelCluster.open();
    }
  }

  open(cb) {
    this._init((err, info) => {
      if (err) {
        return cb(err);
      }

      this.clientId = info.name;
      this.url = info.url;

      // `cached_url` is only returned by proxy servers that support resource caching.
      if (info.cached_url) {
        this.cachedUrl = info.cached_url;
      }

      this._establish(info);
      
      // Start IP change detection if enabled
      if (this.opts.detectIpChanges !== false) {
        this._startIpChangeDetection();
      }
      
      cb();
    });
  }

  close() {
    this.closed = true;
    this._stopIpChangeDetection();
    this.emit('close');
  }
  
  // Get the current public IP address
  async _getCurrentIp() {
    try {
      // Use the tunnel server's API to get our current IP
      const response = await axios.get(`${this.opts.host}/api/ip`);
      return response.data.ip;
    } catch (err) {
      debug(`Error getting current IP: ${err.message}`);
      return null;
    }
  }
  
  // Start periodic IP change detection
  _startIpChangeDetection() {
    // Use the configured check interval or default to 15 seconds
    const CHECK_INTERVAL = this.opts.checkIpInterval || 15 * 1000;
    
    this.ipCheckInterval = setInterval(async () => {
      if (this.closed) {
        this._stopIpChangeDetection();
        return;
      }
      
      await this._checkForIpChange();
    }, CHECK_INTERVAL);
    
    // Also check for IP changes when network events occur if enabled
    if (this.opts.monitorNetwork !== false) {
      this._setupNetworkChangeListeners();
    }
    
    // Do an immediate check to establish baseline
    setTimeout(() => this._checkForIpChange(), 1000);
  }
  
  // Check if the IP has changed and handle it if needed
  async _checkForIpChange() {
    try {
      const newIp = await this._getCurrentIp();
      
      // If we couldn't get the IP or it hasn't changed, do nothing
      if (!newIp || newIp === this.currentIp) {
        return;
      }
      
      debug(`IP address changed from ${this.currentIp} to ${newIp}`);
      
      // Notify the server about the IP change
      await this._notifyIpChange(this.currentIp, newIp);
    } catch (err) {
      debug(`Error in IP change detection: ${err.message}`);
      // If there's an error, emit it but don't stop the tunnel
      this.emit('ip-change-error', err);
    }
  }
  
  // Set up listeners for network change events
  _setupNetworkChangeListeners() {
    try {
      // Check if we're in a Node.js environment that supports network events
      if (typeof process !== 'undefined' && process.on) {
        // Listen for SIGCONT which is sent when a process is resumed after being suspended
        // This can happen when a laptop wakes from sleep
        process.on('SIGCONT', () => {
          debug('Process resumed, checking for IP change');
          setTimeout(() => this._checkForIpChange(), 1000);
        });
      }
      
      // In browser environments, listen for online events
      if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('online', () => {
          debug('Network connection restored, checking for IP change');
          setTimeout(() => this._checkForIpChange(), 1000);
        });
      }
    } catch (err) {
      debug(`Error setting up network change listeners: ${err.message}`);
    }
  }
  
  // Stop IP change detection
  _stopIpChangeDetection() {
    if (this.ipCheckInterval) {
      clearInterval(this.ipCheckInterval);
      this.ipCheckInterval = null;
    }
    
    // Remove network change listeners
    try {
      if (typeof process !== 'undefined' && process.removeListener) {
        process.removeListener('SIGCONT', this._checkForIpChange);
      }
      
      if (typeof window !== 'undefined' && window.removeEventListener) {
        window.removeEventListener('online', this._checkForIpChange);
      }
    } catch (err) {
      debug(`Error removing network change listeners: ${err.message}`);
    }
  }

  // Notify the server about an IP change
  async _notifyIpChange(oldIp, newIp) {
    try {
      debug(`Notifying server about IP change: ${oldIp} -> ${newIp}`);
      
      const response = await axios.post(
        `${this.opts.host}/api/tunnels/${this.clientId}/ip-change`,
        { oldIp },
        { responseType: 'json' }
      );
      
      if (response.status === 200) {
        // Update the stored IP
        this.currentIp = newIp;
        debug('IP change successful');
        this.emit('ip-change', { oldIp, newIp, success: true });
        return true;
      }
      
      throw new Error(`Unexpected response: ${response.status}`);
    } catch (err) {
      // Handle different error scenarios
      if (err.response) {
        const { status, data } = err.response;
        
        debug(`IP change failed with status ${status}: ${data.message}`);
        
        if (status === 404) {
          // Tunnel not found - it may have expired
          const error = new Error('Tunnel no longer exists');
          error.code = 'ETUNNELEXPIRED';
          this.emit('ip-change', { oldIp, newIp, success: false, error });
          this.emit('error', error);
        } else if (status === 403) {
          // IP mismatch - someone else may have taken over the tunnel
          const error = new Error('IP address mismatch');
          error.code = 'EIPMISMATCH';
          this.emit('ip-change', { oldIp, newIp, success: false, error });
          this.emit('error', error);
        } else if (status === 409) {
          // Conflict - tunnel ID already in use at new IP
          const error = new Error('Tunnel ID already in use at new IP');
          error.code = 'ETUNNELCONFLICT';
          this.emit('ip-change', { oldIp, newIp, success: false, error });
          this.emit('error', error);
        } else {
          // Other error
          const error = new Error(data.message || 'Failed to update IP address');
          this.emit('ip-change', { oldIp, newIp, success: false, error });
          this.emit('error', error);
        }
      } else {
        // Network error or other issue
        debug(`IP change request failed: ${err.message}`);
        this.emit('ip-change', { oldIp, newIp, success: false, error: err });
        this.emit('error', err);
      }
      
      return false;
    }
  }
};

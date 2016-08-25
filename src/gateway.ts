import * as monitor from 'node-docker-monitor';
import * as http from 'http';
import * as msgpack from 'msgpack-lite';
import * as nanomsg from 'nanomsg';
import * as bunyan from 'bunyan';

let log = bunyan.createLogger({
  name: 'gateway',
  streams: [
    {
      level: 'info',
      path: '/var/log/gateway-info.log',  // log ERROR and above to a file
      type: 'rotating-file',
      period: '1d',   // daily rotation
      count: 7        // keep 7 back copies
    },
    {
      level: 'error',
      path: '/var/log/gateway-error.log',  // log ERROR and above to a file
      type: 'rotating-file',
      period: '1w',   // daily rotation
      count: 3        // keep 7 back copies
    }
  ]
});

let routes = {}; // {mod: {docker-id: addr}}

var dockerOpts = null;

if (!process.env.DOCKER_SOCKET) {
  if (!process.env.Docker_HOST) {
    dockerOpts = {
      socketPath: '/var/run/docker.sock'
    };
  } else {
    dockerOpts = {
      host: process.env.DOCKER_HOST,
      port: process.env.DOCKER_PORT
    }
  }
} else {
  dockerOpts = {
    socketPath: process.env.DOCKER_SOCKET 
  }
}

monitor({
  onContainerUp: function (containerInfo, docker) {
    if (containerInfo.Labels && containerInfo.Labels.api_module) {
      // register a new route if container has "api_module" label defined
      let container = docker.getContainer(containerInfo.Id);
      // get running container details
      container.inspect(null, (err, containerDetails) => {
        if (err) {
          log.error(err, 'Error getting container details for: %j', containerInfo);
        } else {
          try {
            // prepare and register a new route
            let route = {
              mod: containerInfo.Labels.api_module,
              addr: getUpstreamAddress(containerDetails)
            };

            routes[containerInfo.Id] = route;
            log.info('Registered new api route: %j', route);
          } catch (e) {
            log.error(e, 'Error creating new api route for: %j', containerDetails);
          }
        }
      });
    }
  },

  onContainerDown: function (container, docker) {
    if (container.Labels && container.Labels.api_module) {
      // remove existing route when container goes down
      var route = routes[container.Id];
      if (route) {
        delete routes[container.Id];
        log.info('Removed api route: %j', route);
      }
    }
  },

  onMonitorStarted: function (monitor, docker) {
  },

  onMonitorStopped: function (monitor, docker) {
  }
}, dockerOpts);

// create and start http server
let server = http.createServer((req, rep) => {
  if (req.headers.origin) {
    rep.setHeader('Access-Control-Allow-Origin', req.headers.origin);
  } else {
    rep.setHeader('Access-Control-Allow-Origin', '*');
  }
  rep.setHeader('Access-Control-Allow-Credentials', 'true');
  rep.setHeader('Access-Control-Allow-Methods', 'POST');

  if (req.method == 'POST') {
    let chunks = [];
    req.on('data', (chunk) => {
      chunks.push(chunk);
    });
    req.on('end', () => {
      const data = msgpack.decode(Buffer.concat(chunks));
      const mod = data.mod;
      const fun = data.fun;
      const arg = data.arg;
      let found = false;

      for (let id in routes) {
        if (routes.hasOwnProperty(id) && routes[id].mod === mod) {
          found = true;
          let params = {
            ctx: { domain: 'mobile', ip: req.connection.remoteAddress, uid: ''},
            fun: fun,
            args: arg
          };
          log.info({params: params}, 'call %s.%s %s', mod, fun, JSON.stringify(arg));
          let request = nanomsg.socket('req');
          let addr = routes[id].addr;
          request.connect(addr);
          request.send(msgpack.encode(params));
          request.on('data', (msg) => {
            rep.writeHead(200, {'Content-Type': 'application/octet-stream'});
            rep.write(msg);
            rep.end();
            request.close();
          });
        }
      }
      if (!found) {
        log.info('%s.%s %s not found', mod, fun, JSON.stringify(arg));
        rep.writeHead(404, {'Content-Type': 'text/plain'});
        rep.end('Module not found');
      }
    });
  } else {
    log.info('%s %s invalid rpc call', req.method, req.url);
    rep.writeHead(405, {'Content-Type': 'text/plain'});
    rep.end('Invalid rpc call');
  }
});

// generate upstream address from containerDetails
function getUpstreamAddress(containerDetails) {
  let ports = containerDetails.NetworkSettings.Ports;
  for (let id in ports) {
    if (ports.hasOwnProperty(id)) {
      if (containerDetails.NetworkSettings.Networks) {
        for (let attr in containerDetails.NetworkSettings.Networks) {
          if (containerDetails.NetworkSettings.Networks.hasOwnProperty(attr)) {
            return 'tcp://' + containerDetails.NetworkSettings.Networks[attr].IPAddress + ':' + id.split('/')[0];
          }
        }
      } else {
        return 'tcp://' + containerDetails.NetworkSettings.IPAddress + ':' + id.split('/')[0];
      }
    }
  }
  return null;
}

log.info('API gateway is listening on port: 8000');
server.listen(8000);

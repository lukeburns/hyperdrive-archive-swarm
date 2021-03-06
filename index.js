var webRTCSwarm = require('webrtc-swarm')
var signalhub = require('signalhub')
var pump = require('pump')
var inherits = require('inherits')
var events = require('events')
var discoverySwarm = require('discovery-swarm')
var swarmDefaults = require('datland-swarm-defaults')

var DEFAULT_SIGNALHUB = 'https://signalhub.mafintosh.com'

module.exports = HyperdriveSwarm

function HyperdriveSwarm (archive, opts) {
  if (!(this instanceof HyperdriveSwarm)) return new HyperdriveSwarm(archive, opts)
  var self = this

  if (!opts) opts = {}

  self.connections = 0
  self.signalhub = opts.signalhub || DEFAULT_SIGNALHUB
  self.archive = archive
  self.browser = null
  self.node = null
  self.opts = opts
  if (opts.webrtc || webRTCSwarm.WEBRTC_SUPPORT) self._browser()
  if (process.versions.node) self._node()

  events.EventEmitter.call(this)
}

inherits(HyperdriveSwarm, events.EventEmitter)

HyperdriveSwarm.prototype.close = function (cb) {
  if (cb) this.once('close', cb)
  var self = this

  var swarms = [this.node, this.browser].filter(Boolean)
  swarms.forEach(function (swarm) {
    swarm.once('close', function () {
      var i = swarms.indexOf(swarm)
      if (i > -1) swarms.splice(i, 1)
      if (swarms.length === 0) self.emit('close')
    })
    process.nextTick(function () {
      swarm.close()
    })
  })
}

HyperdriveSwarm.prototype._browser = function () {
  var self = this
  var swarmKey = (self.opts.signalhubPrefix || 'dat-') + self.archive.discoveryKey.toString('hex')
  self.browser = webRTCSwarm(signalhub(swarmKey, self.signalhub), {wrtc: self.opts.wrtc})
  self.browser.on('peer', function (conn) {
    var peer = self.archive.replicate()
    self.connections++
    peer.on('close', function () { self.connections-- })
    self.emit('connection', peer, {type: 'webrtc-swarm'})
    pump(conn, peer, conn)
  })
  return self.browser
}

HyperdriveSwarm.prototype._node = function () {
  var self = this

  var swarm = discoverySwarm(swarmDefaults({
    id: self.archive.id,
    hash: false,
    stream: function (peer) {
      return self.archive.replicate()
    }
  }, self.opts))

  swarm.on('connection', function (peer) {
    self.connections++
    peer.on('close', function () { self.connections-- })
    self.emit('connection', peer, {type: 'discovery-swarm'})
  })

  swarm.on('listening', function () {
    swarm.join(self.archive.discoveryKey)
  })

  swarm.once('error', function () {
    swarm.listen(0)
  })

  swarm.listen(self.opts.port || 3282)
  self.node = swarm
  return swarm
}

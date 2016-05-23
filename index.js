var path = require('path')
var raf = require('random-access-file')
var debug = require('debug')('hyperdrive-swarm')
var walker = require('folder-walker')
var hyperdrive = require('hyperdrive')
var speedometer = require('speedometer')
var pump = require('pump')
var each = require('stream-each')
var through = require('through2')
var discoverySwarm = require('discovery-swarm')
var events = require('events')

module.exports = Swarm

var DEFAULT_PORT = 3282
var DEFAULT_DISCOVERY = [
  'discovery1.publicbits.org',
  'discovery2.publicbits.org'
]
var DEFAULT_DOMAIN = 'Hyperdrive.local'

function Swarm (opts) {
  if (!(this instanceof Swarm)) return new Swarm(opts)
  if (!opts) opts = {}
  var self = this
  self.fs = opts.fs || require('./fs.js')
  self.level = opts.db || require('./db.js')(opts)
  var drive = hyperdrive(self.level)
  self.drive = drive
  self.allPeers = {}
  self.blacklist = {}
  self.status = {}

  var discovery = opts.discovery !== false
  self.swarm = discoverySwarm({
    dns: discovery && {server: DEFAULT_DISCOVERY, domain: opts.domain || DEFAULT_DOMAIN},
    dht: discovery
  })
  self.swarm.listen(opts.port || DEFAULT_PORT)
  self.swarm.once('error', function (err) {
    if (err.code === 'EADDRINUSE') self.swarm.listen(0) // asks OS for first open port
    else throw err
  })
}

Swarm.DNS_SERVERS = DEFAULT_DISCOVERY

Swarm.prototype.scan = function (dirs, onEach, cb) {
  var stream = walker(dirs, {filter: function (Swarma) {
    if (path.basename(Swarma) === '.Swarm') return false
    return true
  }})

  each(stream, function (Swarma, next) {
    var item = {
      name: Swarma.relname,
      path: path.resolve(Swarma.filepath),
      mtime: Swarma.stat.mtime.getTime(),
      ctime: Swarma.stat.ctime.getTime(),
      size: Swarma.stat.size,
      root: Swarma.root
    }

    var isFile = Swarma.stat.isFile()
    if (isFile) {
      item.type = 'file'
    }
    var isDir = Swarma.stat.isDirectory()
    if (isDir) item.type = 'directory'
    onEach(item, next)
  }, cb)
}

Swarm.prototype.fileStats = function (dir, cb) {
  this.scan(dir, eachItem, done)

  var totalStats = {
    filesTotal: 0,
    directories: 0,
    bytesTotal: 0,
    latest: null
  }

  function eachItem (item, next) {
    if (item.type === 'file') {
      totalStats.filesTotal++
      totalStats.bytesTotal += item.size
      if (item.mtime > totalStats.latest) totalStats.latest = item.mtime
    } else if (item.type === 'directory') {
      totalStats.directories++
    }
    next()
  }

  function done (err) {
    if (err) return cb(err)
    cb(null, totalStats)
  }
}

Swarm.prototype.link = function (dir, cb) {
  var self = this
  if (Array.isArray(dir)) throw new Error('cannot specify multiple dirs in .link')
  self.fileStats(dir, function (err, totalStats) {
    if (err) throw err
    var archive = self.drive.createArchive({
      file: function (name) {
        console.log('file', dir, name)
        return raf(path.join(dir, name))
      }
    })
    self.scan(dir, eachItem, done)
    var emitter = new events.EventEmitter()

    var stats = self.status[dir] = {
      total: totalStats,
      state: 'inactive',
      dir: dir,
      progress: {
        bytesRead: 0,
        bytesDownloaded: 0,
        filesRead: 0,
        filesDownloaded: 0
      },
      uploaded: {
        bytesRead: 0
      },
      fileQueue: []
    }

    var uploadRate = speedometer()
    archive.on('upload', function (entry, Swarma) {
      stats.uploaded.bytesRead += Swarma.length
      stats.uploadRate = uploadRate(Swarma.length)
      emitter.emit('stats')
    })

    return emitter

    function eachItem (item, next) {
      var fileStats = {bytesRead: 0}
      if (path.normalize(item.path) === path.normalize(item.root)) return next()
      debug('appending', item)
      archive.append(item.name, function () {
        stats.progress.filesRead += 1
        stats.progress.bytesRead += item.size
        debug('done adding', item.name)
        fileStats.bytesRead += item.size
        emitter.emit('stats')
        next()
      })

      // This could accumulate too many objects if
      // logspeed is slow & scanning many files.
      if (item.type === 'file') {
        stats.fileQueue.push({
          name: item.name,
          stats: fileStats
        })
      }
    }

    function done (err) {
      if (err) return cb(err)
      archive.finalize(function (err) {
        if (err) return cb(err)
        var link = archive.key.toString('hex')
        emitter.emit('stats')
        self.status[dir].link = link
        cb(null, link)
      })
    }
  })
}

Swarm.prototype.leave = function (dir) {
  var self = this
  debug('leaving', Swarm)
  var Swarm = self.status[dir]
  var link = self._normalize(Swarm.link)
  debug('left', link)
  self.swarm.leave(new Buffer(link, 'hex'))
  self.status[dir].state = 'inactive'
  return
}

Swarm.prototype.close = function (cb) {
  var self = this
  self.swarm.destroy(cb)
}

Swarm.prototype._normalize = function (link) {
  return link.replace('Swarm://', '').replace('Swarm:', '')
}

Swarm.prototype.get = function (link, dir) {
  var key = this._normalize(link)
  return this.drive.get(key, dir)
}

// returns object that is used to render progress bars
Swarm.prototype.join = function (link, dir, opts, cb) {
  var self = this
  if ((typeof opts) === 'function') return this.join(link, dir, {}, opts)
  if (!opts) opts = {}
  if (!cb) cb = function noop () {}
  if (!link) return cb(new Error('Link required'))
  if (!dir) return cb(new Error('Directory required'))

  link = new Buffer(this._normalize(link), 'hex')
  debug('joining', link)
  var archive = self.drive.createArchive(link, {
    file: function (name) {
      debug('raf', dir, name)
      return raf(path.join(dir, name))
    }
  })
  self.swarm.join(link)
  self.swarm.on('connection', function (connection) {
    connection.pipe(archive.replicate()).pipe(connection)
  })

  var downloader = through.obj(function (entry, enc, next) {
    debug('downloading', entry)
    archive.download(entry, function (err) {
      if (err) return next(err)
      debug('finished downloading %s to %s', entry.name, dir)
      next()
    })
  })
  pump(archive.list(), downloader, cb)
}
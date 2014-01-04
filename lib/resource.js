'use strict';
var Backbone
  , _ = require('lodash')
  , path = require('path')
  , _url = require('url')
  , qs = require('querystring')
  , http = require('http')
  , https = require('https')
  , SSE = require('sse')
  , idPattern = '([._a-zA-Z0-9-%]+)'
  , app
  , Resource = function(collection, options, callback){
    var cb = !callback ? function(){} : callback

    this.init(collection, options, cb)
  }
  , nameMap = {}
  , getCollectionName = function(url){
    // ensure that we're only looking at the pathname
    url = _url.parse(url).pathname

    if (nameMap[url]) return nameMap[url]

    // looks like url has some "noise" at the end
    var urlParts = url.split('/')
    // remove trailing slashes
    while (urlParts.length > 0 && !urlParts[urlParts.length - 1]) urlParts.pop()

    do {
      // do we have collection already?
      url = urlParts.join('/')
      if (nameMap[url]) return nameMap[url]

      // no? pop one element then
      urlParts.pop()
    } while (urlParts.length > 0)

    // if we can't find a url to map to, bail
    return undefined
  }
  // wrapper for isPermissible becuase we're gonna want to do the same thing for all CRUD
  , permissible = function(collOrModel){
    if (this.isPermissible.call(this, collOrModel, this.req.body)) return true

    app.log.warn('resource: permission:', this.req.method + ' permission denied'
      , {url: this.req.url, user: (this.req.user ? this.req.user.id : null)}
    )
    this.res.writeHead(403, { 'Content-Type': 'application/json'} )
    this.res.json({code: 403, message: 'Permission denied.'})
    return false
  }

Resource.prototype.init = function(collection, options, callback){
  var coll
    , collName
    , self = this

  if (!options.app.router)
    throw new Error('Resource needs an app with a router instance')

  app = options.app
  Backbone = app.Backbone

  // establish the collection
  if (collection instanceof Backbone.Collection) coll = collection
  else if (_.isString(collection) && app.datas[collection]) coll = app.datas[collection]
  else if (_.isString(collection)) {
    this.Collection = Backbone.Collection.extend({
      url: path.join('/', collection)
    })
    coll = new this.Collection()
  }
  else {
    throw new Error('Resource init needs a collection')
  }

  coll.resource = {}
  coll.resource.permissions = options.permissions
  coll.resource.pick = options.pick || function(m){return m}
  coll.resource.filter = options.filter || function(c){return c}
  coll.resource.nameRegEx = options.nameRegEx

  this.collection = coll
  nameMap[_.result(coll, 'url')] = this.getName(coll, options.nameRegEx)
  this.name = collName = getCollectionName(_.result(coll, 'url'))
  this.options = options

  if (!app.router) throw new Error('wheelhouse-resource needs app.router to exist before it can create new resources.')

  app.router.attach(function(){
    this.collections = this.collections || {}
    this.collections[collName] = coll
    if (!this.isPermissible) this.isPermissible = self.getPermissions.bind(this)
  })

  // get collection data
  if (this.collection.length === 0) this.collection.fetch({
    error: function(collection, err){
      app.log.error('resource: fetch:' + collName, {collection: collName, err: new Error()})
      if (_.isFunction(callback)) callback(err, collection)
    }
    , success: function(collection){
      app.log.info('resource: found ' + collection.length + ' models for ' + collection.url)
      if (_.isFunction(callback)) callback(null, collection)
    }
  })
  else {
    app.log.info('resource: found ' + collection.length + ' preexisting models for ' + collection.url + ', not fetching from db')
  }

  // Optionally let route assignment be disabled
  if (options.assignRoutes !== false) this.assignRoutes()
}

Resource.prototype.assignRoutes = function(){
  // SSE routes should be installed first, so that they wouldn't be overshadowed by common matches
  this.sse()

  // default '/:param' syntax doesn't work for urlencoded values, we we need to hack that.
  // https://github.com/flatiron/director/pull/211
  app.router.get(path.join('/', this.collection.url), this.read)
  app.router.get(path.join('/', this.collection.url, '/' + idPattern), this.read)
  app.router.post(path.join('/', this.collection.url), this.create)
  app.router.put(path.join('/', this.collection.url, '/' + idPattern), this.update)
  app.router['delete'](path.join('/', this.collection.url, '/' + idPattern), this.del)

  // allow many connections for SSE
  http.globalAgent.maxSockets  = this.options.maxSockets || 1000
  https.globalAgent.maxSockets = this.options.maxSockets || 1000
}

Resource.prototype.getName = function(collection, regex){
  var url = _.result(collection, 'url')
    , err = {
      url: url
      , regex: regex
      , matches: null
      , expecting: 'matches to be an array of regex matches'
    }
    , matches

  if (regex){
    matches = url.match(regex)
    if (!_.isArray(matches)){
      err.matches = matches
      app.log.error('resource: init: cannot match name', err)
      throw err
    }
    return matches[1]
  }
  else return url.substring(1)
}

// should be called in the context of a flatiron route (e.g. this.req, this.res)
Resource.prototype.getPermissions = function(collOrModel, data){
  var methodMap = {
      'POST': 'create'
      , 'GET': 'read'
      , 'PUT': 'update'
      , 'DELETE': 'del'
    }
    , collection
    , model
    , permissions

  // find the collection so we can pull of it's permissions
  if (collOrModel) {
    if (collOrModel.models) collection = collOrModel
    else {
      collection = collOrModel.collection
      model = collOrModel
    }
  }
  else collection = this.collections[getCollectionName(this.req.url)]

  // no collection - no access
  if (_.isUndefined(collection)) {
    app.log.warn('resource: permissions: attempted to access resource with no collection', {resource: this.name})
    return false
  }

  // if no permissions have been set, assume full access
  if (_.isUndefined(collection.resource.permissions))
    permissions = ['create', 'read', 'update', 'del']

  // build permissions
  else if (_.isFunction(collection.resource.permissions))
    permissions = collection.resource.permissions.call(this, collection, data)
  else permissions = collection.resource.permissions

  // determine if this request is permissible
  // simple permissions
  if (_.isArray(permissions)){
    if (permissions.indexOf(methodMap[this.req.method]) > -1) return true
    else return false
  }
  // we didn't get anything back, so deny all permissions
  else if (!_.isObject(permissions)) return false
  // complex permissions
  else return permissions[methodMap[this.req.method]].call(this, model ? model.toJSON() : collection.toJSON(), data)
}

Resource.prototype.sse = function(){
  var resource = this
    , responder
    , onConnection

  // sends model or collection events over the SSE connection if permissible
  responder = function(client, collectionOrModel, e) {
    if (!collectionOrModel || !e) return app.log.warn('router: see: send: attempted to respond to a non-existant model or collection', {event: e, collectionOrModel: collectionOrModel, url: client.req.url})
    client.ears.listenTo.call(this, collectionOrModel, e, function(model){
      // ensure the user is allowed to see this model
      var permissions = this.getPermissions.call(client, this.collection)
        , meta = {resource: this.name}

      if (model) meta.model = model.id
      if (client.req.user) meta.user = client.req.user.id
      app.log.debug('router: sse: send ' + e + ':', meta)

      if (permissions === true || _.isArray(permissions) && _.find(permissions, function(permittedModel){
        return model.id === permittedModel[model.idAttribute]
      })) client.send(e, JSON.stringify(model.toJSON()))
      // TODO: this is kinda hacky, we always send destroys, even if they're not permitted to see them. This isn't a huge deal because the event will only show ids, but… not super secure.
      // The reason we have to do this is b/c we're basing this off the model/collection destroy/remove event, which means that the model is already removed from the collection by the time complex permissions go to try to see if the model is permissible.
      else if (['destroy', 'remove'].indexOf(e) > -1)
        client.send(e, JSON.stringify({id: model.id}))
    })
  }

  // called after a SSE connection has been permitted
  onConnection = function(collOrModel, events, client) {
    var timeStart = Date.now()
      , keepAlive

    app.log.debug('resource: sse: client connect:', {resource: this.name})

    client.ears = {}
    _.extend(client.ears, Backbone.Events)

    events.forEach(function(e){
      responder.call(this, client, collOrModel, e)
    }.bind(this))

    keepAlive = setInterval(function(){
      // start with colon so that it's interpreted as a comment
      // https://developer.mozilla.org/en-US/docs/Server-sent_events/Using_server-sent_events
      client.send(':keepAlive')
      app.log.debug('resource: sse: client keepAlive:', {resource: this.name, timeConnected: Date.now() - timeStart, user: client.req.user ? client.req.user.id : null})
    }.bind(this), 20 * 1000)

    // shim flatiron's res object which doesn't emit a close event.
    client.res.response.on('close', function(){
      client.emit('close')
    })

    client.on('close', function(){
      client.ears.stopListening()
      clearInterval(keepAlive)
      app.log.debug('resource: sse: client disconnect:', {resource: this.name, timeConnected: Date.now() - timeStart, user: client.req.user ? client.req.user.id : null})
      // ensure the client is destroyed.
      // might be the cause of a memory leak?
      client = null
    }.bind(this))
  }

  // route for whole collection event subscription handling
  app.router.get(path.join('/', this.collection.url, '/subscribe'), function(id){
    var client

    if (!permissible.call(this, resource.collection, {id: id})) return

    client = new SSE.Client(this.req, this.res)
    client.initialize()
    onConnection.call(resource, resource.collection, ['add', 'change', 'remove'], client)
  })

  // setup route for model event subscription handling
  app.router.get(path.join('/', this.collection.url, '/' + idPattern + '/subscribe'), function(id){
    var model
      , client

    model = resource.collection.get(decodeURIComponent(id))
    if (!permissible.call(this, model)) return

    client = new SSE.Client(this.req, this.res)
    client.initialize()
    onConnection.call(resource, model, ['change', 'destroy'], client)
  })
}

Resource.prototype.read = function(id){
  var name = getCollectionName(this.req.url)
    , collection = this.collections[name]
    , permissibles = this.isPermissible.call(this)
    , query = qs.parse(_url.parse(this.req.url).query)
    , model
    , filteredSet
    , picks
    , omits
    , returnSet

  if (query && query.pick) picks = query.pick.split(',')
  if (query && query.omit) omits = query.omit.split(',')

  // if isPermissible returned false, we don't have permission, bail
  if (!permissibles) {
    app.log.warn('resource: read: permission: permission denied:', {collection: name, permissionSet: permissibles})
    this.res.writeHead(403)
    this.res.json({code: 403, message: 'No permission for ' + name})
    return
  }

  // single model requested
  if (id && !_.isFunction(id)){
    model = collection.get(decodeURIComponent(id))

    if (!model) {
      app.log.warn('resource: read: ' + name + ': Model ' + id + ' does not exist.')
      this.res.writeHead(404)
      this.res.json({code: 404, message: 'Model ' + id + ' does not exist.'})
    }
    else {
      // if permissions has narrowed down the models we're allowed to present
      // ensure the requested model is allowed
      if (permissibles !== true) {
        filteredSet = _.find(permissibles, function(m){
          return m[model.idAttribute] === model.id
        })
        if (!filteredSet) {
          app.log.warn('resource: read: permission: model requested, but permission denied', {model: model.id, permissionSet: permissibles})
          this.res.writeHead(403)
          this.res.json({code: 403, message: 'No permission for ' + model.id})
          return
        }
      }

      returnSet = collection.resource.pick.call(this, model.toJSON())

      if (picks) returnSet = _.pick(returnSet, function(value, key){
        return picks.indexOf(key) > -1
      })
      if (omits) returnSet = _.omit(returnSet, function(value, key){
        return omits.indexOf(key) > -1
      })

      this.res.json(returnSet)
    }
  }
  // collection requested
  else {
    // if permissions has narrowed down the models we're allowed to present, use that
    filteredSet = permissibles === true
      ? collection.toJSON()
      : permissibles

    returnSet = collection.resource.filter.call(this, filteredSet)

    if (picks) returnSet = returnSet.map(function(model){
      return _.pick(model, function(value, key){
        return picks.indexOf(key) > -1
      })
    })
    if (omits) returnSet = returnSet.map(function(model){
      return _.omit(model, function(value, key){
        return omits.indexOf(key) > -1
      })
    })

    this.res.json(returnSet)
  }
}

Resource.prototype.create = function(){
  var name = getCollectionName(this.req.url)
    , collection = this.collections[name]
    , data = this.req.body

  if (!permissible.call(this, collection)) return

  collection.create(data, {
    error: function(model, err){
      app.log.error('resource: create: ' + name + ':', {model: model, err: err, stack: new Error(err).stack})
      this.res.writeHead(500)
      this.res.json({code: 500, message: 'create error', model: model})
    }.bind(this)
    , success: function(model){
      app.log.info('resource: create: ' + name + ':', {model: model.id})
      this.res.writeHead(206)
      this.res.json(_.pick(model.attributes, function(val, key){
        return key.indexOf('_') === 0 || key === model.idAttribute
      }))
    }.bind(this)
    , wait: true
  })
}

Resource.prototype.update = function(rawId){
  var name = getCollectionName(this.req.url)
    , id = decodeURIComponent(rawId)
    , model = this.collections[name].get(id)
    , data = this.req.body

  if (!permissible.call(this, model)) return

  if (!model){
    app.log.error('resource: update: ' + name + ': Model ' + id + ' does not exist.', new Error())
    this.res.writeHead(404)
    return this.res.json({code: 404, message: 'Model ' + id + ' does not exist.'})
  }

  // set first, then save. This is effectively what `wait: true` should do, but backbone-associations doesn't set sub-values until after the save event if we just do a `wait: true`. (`wait` is important so that we don't trigger events until we're sure the db has saved.). Doing a `set` and then a `save` manually fixes the problem.
  // https://github.com/dhruvaray/backbone-associations/issues/72
  model.set(data).save(null, {
    error: function(modelUpdated, err){
      app.log.error('resource: update: ' + name + ':', {model: id, err: err, stack: new Error().stack})
      this.res.writeHead(500)
      this.res.json({code: 500, message: 'update error', model: modelUpdated})
    }.bind(this)
    , success: function(modelUpdated){
      app.log.info('resource: update: ' + name + ':', {model: modelUpdated.id})
      this.res.writeHead(206)
      this.res.json(_.pick(model.attributes, function(val, key){
        return key.indexOf('_') === 0 || key === model.idAttribute
      }))
    }.bind(this)
    , wait: true
  })
}

Resource.prototype.del = function(rawId){
  var name = getCollectionName(this.req.url)
    , id = decodeURIComponent(rawId)
    , model = this.collections[name].get(id)

  if (!permissible.call(this, model)) return

  if (!model) return this.res.json({code: 404, message: 'Model ' + id + ' does not exist.'})

  model.destroy({
    error: function(modelUpdated, err){
      app.log.error('resource: ' + name + ':', {model: id, err: err, stack: new Error().stack})
      this.res.writeHead(500)
      this.res.json({code: 500, message: 'delete error', model: modelUpdated})
    }.bind(this)
    , success: function(modelUpdated){
      app.log.info('resource: delete: ' + name + ':', {model: modelUpdated.id})
      this.res.writeHead(204)
      this.res.json()
    }.bind(this)
    , wait: true
  })
}

module.exports = Resource

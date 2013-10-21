'use strict';
var Backbone
  , _ = require('lodash')
  , path = require('path')
  , http = require('http')
  , https = require('https')
  , SSE = require('sse')
  , app
  , Resource = function(collection, options, callback){
    var cb = !callback ? function(){} : callback

    this.init(collection, options, cb)
  }
  , nameMap = {}
  , getCollectionName = function(url){
    if (nameMap[url]) return nameMap[url]

    // looks like url has some "noise" at the end
    var urlParts = url.split('/')
    // remove trailing slashes
    while (urlParts.length > 0 && !urlParts[urlParts.length - 1]) urlParts.pop()

    // do we have collection already?
    url = urlParts.join('/')
    if (nameMap[url]) return nameMap[url]

    // no, pop the id then
    urlParts.pop()
    url = urlParts.join('/')
    return nameMap[url]
  }
  // wrapper for isPermissible becuase we're gonna want to do the same thing for all CRUD
  , permissible = function(collOrModel, data){
    if (this.isPermissible.call(this, collOrModel, data)) return true

    app.log.warn('resource: permission:', this.req.method + ' permission denied for ' + this.req.url + (this.req.user ? ' for ' + this.req.user.get('email') : ''))
    this.res.writeHead(403, { 'Content-Type': 'application/json'} )
    this.res.json({code: 403, message: 'Permission denied.'})
    return false
  }

Resource.prototype = {
  init: function(collection, options, callback){
    var coll
      , collName
      , self = this

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
        app.log.error('resource: fetch:', collName)
        if (_.isFunction(callback)) callback(err, collection)
      }
      , success: function(collection){
        app.log.info('resouce: found ' + collection.length + ' models for ' + collection.url)
        if (_.isFunction(callback)) callback(null, collection)
      }
    })
    else {
      app.log.info('resouce: found ' + collection.length + ' preexisting models for ' + collection.url + ', not fetching from db')
    }

    app.router.get(path.join('/', this.collection.url), this.read)
    app.router.get(path.join('/', this.collection.url, '/*'), this.read)
    app.router.post(path.join('/', this.collection.url), this.create)
    app.router.put(path.join('/', this.collection.url, '/*'), this.update)
    app.router['delete'](path.join('/', this.collection.url, '/*'), this.del)
    this.sse()

    // allow many connections for SSE
    http.globalAgent.maxSockets = options.maxSockets || 1000
    https.globalAgent.maxSockets = options.maxSockets || 1000
  }
  , getName: function(collection, regex){
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
  , getPermissions: function(collOrModel, data){
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

    permissions = collection.resource.permissions

    // if no permissions have been set, assume full access
    if (_.isUndefined(permissions)) permissions = ['create', 'read', 'update', 'del']

    // build permissions if need be
    if (_.isFunction(permissions)) permissions = permissions.call(this, collection, data)

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
  , sse: function(){
    var
      // sends model or collection events over the SSE connection if permissible
      responder = function sseEventSend (client, collectionOrModel, e){
        client.ears.listenTo.call(this, collectionOrModel, e, function(model){
          // ensure the user is allowed to see this model
          var permissions = this.getPermissions.call(client, this.collection)

          app.log.debug('router: sse: send ' + e + ':', {resource: this.name, user: client.req.user})

          if (permissions === true || _.isArray(permissions) && _.find(permissions, function(permittedModel){
            return model.id === permittedModel.id
          })) client.send(e, JSON.stringify(model.toJSON()))
          // TODO: this is kinda hacky, we always send destroys, even if they're not permitted to see them. This isn't a huge deal because the event will only show ids, but… not super secure.
          // The reason we have to do this is b/c we're basing this off the model/collection destroy/remove event, which means that the model is already removed from the collection by the time complex permissions go to try to see if the model is permissible.
          else if (['destroy', 'remove'].indexOf(e) > -1) client.send(e, JSON.stringify({id: model.id}))
        })
      }

      // called after a SSE connection has been permitted
      , onConnection = function sseConnection(collOrModel, events, client){
        var timeStart = Date.now()
          , keepAlive

        app.log.debug('router: sse: client connect:', {resource: this.name})

        client.ears = {}
        _.extend(client.ears, Backbone.Events)

        events.forEach(function(e){
          responder.call(this, client, collOrModel, e)
        }.bind(this))

        keepAlive = setInterval(function(){
          // start with colon so that it's interpreted as a comment
          // https://developer.mozilla.org/en-US/docs/Server-sent_events/Using_server-sent_events
          client.send(':keepAlive')
          app.log.debug('router: sse: client keepAlive:', {resource: this.name, timeConnected: Date.now() - timeStart})
        }.bind(this), 20 * 1000)

        client.on('close', function(){
          client.ears.stopListening()
          clearInterval(keepAlive)
          app.log.debug('router: sse: client disconnect:', {resource: this.name, timeConnected: Date.now() - timeStart})
        }.bind(this))
      }

      // creates a SSE route for a model or collection
      // call in the context of the resource
      , sseResource = function createSseResource (collOrModel, events){
        var resource = this

        collOrModel.resource = collOrModel.resource || {}
        collOrModel.resource.sse = new SSE(app.server, {
          path: path.join(_.result(collOrModel, 'url'), '/subscribe')
          // ensure the user has access to this collection
          , verifyRequest: function(req){
            var permitted = resource.getPermissions.call({req: req}, collOrModel)
            if (!permitted) app.log.warn('router: sse: client not permitted:', {resource: resource.name, user: req.user})
            return permitted
          }
        })

        collOrModel.resource.sse.on('connection', function(client){
          onConnection.call(this, collOrModel, events, client)
        }.bind(this))
      }

    // enable SSE for the whole collection
    sseResource.call(this, this.collection, ['add', 'change', 'remove'])

    // enable SSE for individual models
    this.collection.on('add', function(model){
      sseResource.call(this, model, ['change', 'destroy'])
    }, this)
    // if we have models in the collection at time of initialization, give them routes
    if (this.collection.length) this.collection.each(function(model){
      sseResource.call(this, model, ['change', 'destroy'])
    })
  }
  , read: function(id){
    var name = getCollectionName(this.req.url)
      , collection = this.collections[name]
      , permissibles = this.isPermissible.call(this)
      , model
      , filteredSet

    // if isPermissible returned false, we don't have permission, bail
    if (!permissibles) {
      app.log.warn('resource: read: permission: model requested, but permission denied:', {collection: name, permissionSet: permissibles})
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

        this.res.json(collection.resource.pick.call(this, model.toJSON()))
      }
    }
    // collection requested
    else {
      // if permissions has narrowed down the models we're allowed to present, use that
      filteredSet = permissibles === true
        ? collection.toJSON()
        : permissibles

      this.res.json(collection.resource.filter.call(this, filteredSet))
    }
  }
  , create: function(){
    var name = getCollectionName(this.req.url)
      , collection = this.collections[name]
      , data = this.req.body

    if (!permissible.call(this, collection, data)) return

    collection.create(data, {
      error: function(model){
        app.log.error('resource: create: ' + name + ':', model)
        this.res.writeHead(500)
        this.res.json({code: 500, message: 'create error', model: model})
      }.bind(this)
      , success: function(model){
        app.log.info('resource: create: ' + name + ':', model.id)
        this.res.writeHead(206)
        this.res.json(_.pick(model.attributes, function(val, key){
          return key.indexOf('_') === 0 || key === model.idAttribute
        }))
      }.bind(this)
      , wait: true
    })
  }
  , update: function(rawId){
    var name = getCollectionName(this.req.url)
      , id = decodeURIComponent(rawId)
      , model = this.collections[name].get(id)
      , data = this.req.body

    if (!permissible.call(this, model, data)) return

    // have to remove reserved values so Couch doesn't freak
    // ;delete data._rev
    // ;delete data._id

    if (!model){
      app.log.error('resource: update: ' + name + ': Model ' + id + ' does not exist.')
      this.res.writeHead(404)
      return this.res.json({code: 404, message: 'Model ' + id + ' does not exist.'})
    }

    // set first, then save. This is effectively what `wait: true` should do, but backbone-associations doesn't set sub-values until after the save event if we just do a `wait: true`. (`wait` is important so that we don't trigger events until we're sure the db has saved.). Doing a `set` and then a `save` manually fixes the problem.
    // https://github.com/dhruvaray/backbone-associations/issues/72
    model.set(data, {silent: true}).save(null, {
      error: function(modelUpdated){
        app.log.error('resource: update: ' + name + ':', {model: id})
        this.res.writeHead(500)
        this.res.json({code: 500, message: 'update error', model: modelUpdated})
      }.bind(this)
      , success: function(modelUpdated){
        app.log.info('resource: update:' + name + ':', modelUpdated.id)
        this.res.writeHead(206)
        this.res.json(_.pick(model.attributes, function(val, key){
          return key.indexOf('_') === 0 || key === model.idAttribute
        }))
      }.bind(this)
      , wait: true
    })
  }
  , del: function(rawId){
    var name = getCollectionName(this.req.url)
      , id = decodeURIComponent(rawId)
      , model = this.collections[name].get(id)

    if (!permissible.call(this, model)) return

    if (!model) return this.res.json({code: 404, message: 'Model ' + id + ' does not exist.'})

    model.destroy({
      error: function(modelUpdated){
        app.log.error('resource: ' + name + ':', {model: id})
        this.res.writeHead(500)
        this.res.json({code: 500, message: 'delete error', model: modelUpdated})
      }.bind(this)
      , success: function(modelUpdated){
        app.log.info('resource: delete: ' + name + ':', modelUpdated.id)
        this.res.writeHead(204)
        this.res.json()
      }.bind(this)
      , wait: true
    })
  }
}

module.exports = Resource

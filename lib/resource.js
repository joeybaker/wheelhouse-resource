'use strict';
var Backbone
  , _ = require('lodash')
  , path = require('path')
  , app
  , Resource = function(collection, options, callback){
    var cb = !callback ? function(){} : callback

    this.init(collection, options, cb)
  }
  , nameMap = {}
  , getCollectionName = function(url){
    if (nameMap[url]) return nameMap[url]

    // check to see if the URL has in ID
    var urlParts = url.split('/')
      , last = urlParts.pop()

    if (!last && urlParts.length > 2) urlParts.pop() // if we ended with a trailing slash, actually remove the id
    return nameMap[urlParts.join('/')]
  }
  // wrapper for isPermissible becuase we're gonna want to do the same thing for all CRUD
  , permissible = function(){
    if (this.isPermissible()) return true

    app.log.info('resource: permission:', this.req.method + ' permission denied for ' + this.req.url)
    this.res.writeHead(403)
    this.res.json({status: 403, message: 'Permission denied.'})
    return false
  }

Resource.prototype = {
  init: function(collection, options, callback){
    var coll
      , collName

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
    // add permissions method
    coll.resource = {}
    coll.resource.permissions = options.permissions || function(){
      return ['create', 'read', 'update', 'del']
    }
    coll.resource.pick = options.pick || function(m){return m}
    coll.resource.filter = options.filter || function(c){return c}
    coll.resource.nameRegEx = options.nameRegEx

    this.collection = coll
    nameMap[_.result(coll, 'url')] = this.getName(coll, options.nameRegEx)
    this.name = collName = getCollectionName(_.result(coll, 'url'))
    this.options = options

    app.router.attach(function(){
      this.collections = this.collections || {}
      this.collections[collName] = coll
      if (!this.isPermissible) this.isPermissible = function(){
        var methodMap = {
            'POST': 'create'
            , 'GET': 'read'
            , 'PUT': 'update'
            , 'DELETE': 'del'
          }
          , collection = this.collections[getCollectionName(this.req.url)]
          , permissions = collection.resource.permissions.call(this)

        if (!permissions || permissions.indexOf(methodMap[this.req.method]) > -1) return true
      }.bind(this)
    })

    // get collection data
    if (this.collection.length === 0) this.collection.fetch({
      context: this
      , error: function(collection, err){
        app.log.error('resource: fetch: ', err)
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
  }
  , getName: function(collection, regex){
    var url = _.result(collection, 'url')

    if (regex) return url.match(regex)[1]
    else return url.substring(1)
  }
  , read: function(id){
    var name = getCollectionName(this.req.url)
      , collection = this.collections[name]

    if (!permissible.call(this)) return

    if (id && !_.isFunction(id)){
      var model = collection.get(decodeURIComponent(id))

      if (!model) {
        app.log.error('resource: read: ' + name + ': Model ' + id + ' does not exist.')
        this.res.writeHead(404)
        this.res.json({code: 404, message: 'Model ' + id + ' does not exist.'})
      }
      else this.res.json(collection.resource.pick.call(this, model.toJSON()))
    }
    else this.res.json(collection.resource.filter.call(this, collection.toJSON()))
  }
  , create: function(){
    var name = getCollectionName(this.req.url)
    if (!permissible.call(this)) return

    this.collections[name].create(this.req.body, {
      error: function(model, res){
        app.log.error('resource: create: ' + name + ':', res)
        this.res.writeHead(500)
        this.res.json(res)
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
  , update: function(id){
    var name = getCollectionName(this.req.url)
      , model = this.collections[name].get(decodeURIComponent(id))
      , data = this.req.body

    if (!permissible.call(this)) return

    // have to remove reserved values so Couch doesn't freak
    delete data._rev
    ;delete data._id

    if (!model){
      app.log.error('resource: update: ' + name + ': Model ' + id + ' does not exist.')
      this.res.writeHead(404)
      return this.res.json({code: 404, message: 'Model ' + id + ' does not exist.'})
    }

    model.save(data, {
      error: function(modelUpdated, res){
        app.log.error('resource: update: ' + name + ':', res)
        this.res.writeHead(500)
        this.res.json({code: 500, message: res})
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
  , del: function(id){
    var name = getCollectionName(this.req.url)
      , model = this.collections[name].get(decodeURIComponent(id))

    if (!permissible.call(this)) return

    if (!model) return this.res.json({code: 404, message: 'Model ' + id + ' does not exist.'})

    model.destroy({
      error: function(modelUpdated, res){
        app.log.error('resource: delete:' + name + ':', res)
        this.res.writeHead(500)
        this.res.json({code: 500, message: res})
      }.bind(this)
      , success: function(modelUpdated){
        app.log.info('resource: delete:' + name + ':', modelUpdated.id)
        this.res.writeHead(204)
        this.res.json()
      }.bind(this)
      , wait: true
    })
  }
}

module.exports = Resource

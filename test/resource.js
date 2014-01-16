/* global describe, it, before, after, afterEach */
'use strict';

var chai = require('chai')
  , Resource = require('../index.js')
  , flatiron = require('flatiron')
  , Backbone = require('backbone')
  , _ = require('lodash')
  , request = require('request')
  , EventSource = require('eventsource')
  , path = require('path')
  , should = chai.should()
  , expect = chai.expect
  , sinon = require('sinon')
  , app = flatiron.app
  , cache = {}
  , port = 9070

describe('Resources:', function(){
  before(function(done){
    app.use(flatiron.plugins.http)
    app.router.configure({
      strict: false
    })
    // shut the damn logs up
    app.options.log = {console: {silent: true}}

    // testing only implementation of Backbone.Sync.
    // Really, wheelhouse should have done this for us with something like wheelhouse-couch
    Backbone.sync = function(method, model, options){
      var success = options.success || function(){}

      switch (method){
        case 'read':
          if (model.id)
            success(cache[_.result(model, 'url')])
          else {
            success(_.reduce(cache, function(out, m, id){
              if (id.indexOf(_.result(model, 'url')) > -1) out.push(m)
              return out
            }, []))
          }
          break
        case 'create':
          model.set({id: _.uniqueId()})
          cache[_.result(model, 'url')] = model.toJSON()
          success(model.id)
          break
        case 'update':
          cache[_.result(model, 'url')] = model.toJSON()
          success(model.id)
          break
        case 'delete':
          delete cache[_.result(model, 'url')]
          success()
          break
      }
    }
    app.Backbone = Backbone

    app.start(port, done)
  })

  describe('prerequisites', function(){
    var Collection = Backbone.Collection.extend({
        url: '/collection'
      })
      , collection = new Collection()

    it('app.backbone exists', function(){
      should.exist(app.Backbone)
    })

    it('returns JSON on create()', function(done){
      collection.create({key: 'value'}, {
        success: function(model){
          collection.get(model.id).get('key').should.equal('value')
          cache[_.result(model, 'url')].key.should.equal('value')
          done()
        }
      })
    })

    it('returns JSON on fetch', function(done){
      collection.reset()
      collection.length.should.equal(0)
      collection.fetch({success: function(coll){
        coll.first().get('key').should.equal('value')
        done()
      }})
    })

    after(function(){
      collection.reset()
    })
  })

  describe('a new resource', function(){
    function setup(name, options){
      var Collection = Backbone.Collection.extend({
          url: '/api/' + (name || 'collection')
          , model: Backbone.Model.extend({
            validate: function(attrs){
              if (attrs.invalid) return 'invalid!'
            }
          })
        })
        , collection = new Collection()

      options || (options = {})

      collection.reset()
      cache = {}

      collection.create({key: 'value1'})
      collection.create({key: 'value2'})

      ;new Resource(collection, _.extend({app: app, nameRegEx: /\/api\/(.*)\/?/}, options))
      return collection
    }

    it('adds routes to the router', function(){
      var name = 'addingRoutes'
      setup(name)
      app.router.routes.api[name].get.should.exist
      app.router.routes.api[name]['([._a-zA-Z0-9-%]+)'].get.should.exist
      app.router.routes.api[name].post.should.exist
      app.router.routes.api[name]['([._a-zA-Z0-9-%]+)'].put.should.exist
      app.router.routes.api[name]['([._a-zA-Z0-9-%]+)']['delete'].should.exist
    })

    it('populates the collection on creation', function(){
      var Collection = Backbone.Collection.extend({
        url: '/prePopulated'
      })
        , collection = new Collection()

      // fake like there's already 1 model in the db
      cache['/prePopulated/1'] = {key: 'prePopulatedValue'}

      ;new Resource(collection, {app: app}, function(err, collection){
        should.not.exist(err)
        // we should just get back the model we added to the DB above
        collection.length.should.equal(1)
        collection.first().get('key').should.equal('prePopulatedValue')
      })
    })

    it('creates', function(done){
      var name = 'creates/again'
        , collection = setup(name)
        , complete = _.after(2, done)

      // with out a trailing slash
      request.post({
        url: 'http://localhost:' + port + '/api/' + name
        , json: {key: 'created!'}
      }, function(err, res, body){
        should.not.exist(err)
        should.exist(body.id)
        collection.get(body.id).get('key').should.equal('created!')
        complete()
      })

      // with a trailing slash
      request.post({
        url: 'http://localhost:' + port + '/api/' + name + '/'
        , json: {key: 'created!'}
      }, function(err, res, body){
        should.not.exist(err)
        should.exist(body.id)
        collection.get(body.id).get('key').should.equal('created!')
        complete()
      })
    })

    it('returns an error on create if validation fails', function(done){
      var name = 'creates/validation'
      setup(name)

      request.post({
        url: 'http://localhost:' + port + '/api/' + name
        , json: {invalid: 'created!'}
      }, function(err, res, body){
        should.not.exist(err)
        res.statusCode.should.equal(422)
        body.code.should.equal(422)
        done()
      })
    })

    it('reads a collection', function(done){
      var name = 'readsAColleciton'
      setup(name)
      request.get({
        url: 'http://localhost:' + port + '/api/' + name
        , json: true
      }, function(err, res, body){
        should.not.exist(err)
        body.length.should.be.above(0)
        _.last(body).key.should.equal('value2')
        done()
      })
    })

    it('reads a model', function(done){
      var name = 'readsAModel'
        , collection = setup(name)
        , id = collection.last().id

      expect(collection).to.exist
      expect(id).to.exist

      request.get({
        url: 'http://localhost:' + port + '/api/' + name + '/' + id
        , json: true
      }, function(err, res, body){
        should.not.exist(err)
        body.id.should.equal(id)
        done()
      })
    })

    it('returns modified data on a read of a collection', function(done){
      var name = 'readModification'

      setup(name, {hooks: {read: function(collection, end){
        var newCollection = _.map(collection, function(model){
          model.addedValue = true
          return model
        })

        should.exist(this.req)

        // this should happen async
        setImmediate(function(){
          end(newCollection)
        })
      }}})

      request.get({
        url: 'http://localhost:' + port + '/api/' + name
        , json: true
      }, function(err, res, body){
        should.not.exist(err)
        body.length.should.be.above(0)
        body.length.should.equal(2)
        _.each(body, function(model){
          model.should.include.key('addedValue')
          model.addedValue.should.be.true
        })
        done()
      })
    })

    it('returns modified data on a read of a model', function(done){
      var name = 'readModelModification'
        , collection = setup(name, {hooks: {read: function(collection, end){
          var newCollection = _.map(collection, function(model){
            model.addedValue = true
            return model
          })

          // this should happen async
          setImmediate(function(){
            end(newCollection)
          })
        }}})

      request.get({
        url: 'http://localhost:' + port + '/api/' + name + '/' + collection.last().id
        , json: true
      }, function(err, res, body){
        should.not.exist(err)
        res.statusCode.should.equal(200)
        body.should.be.not.be.an.array
        body.should.include.key('addedValue')
        body.id.should.equal(collection.last().id)
        body.addedValue.should.be.true
        done()
      })
    })

    it('updates', function(done){
      var name = 'updating'
        , collection = setup(name)

      collection.add({id: 1, key: 'not updated'})
      request.put({
        url: 'http://localhost:' + port + '/api/' + name + '/1'
        , json: {id: 1, key: 'updated!'}
      }, function(err, res, body){
        should.not.exist(err)
        body.id.should.equal(1)
        cache['/api/' + name + '/1'].key.should.equal('updated!')
        collection.get(1).get('key').should.equal('updated!')
        done()
      })
    })

    it('returns an error if updates fail validation', function(done){
      var name = 'updating'
        , collection = setup(name)

      collection.add({id: 1, key: 'not updated'}, {merge: true})
      request.put({
        url: 'http://localhost:' + port + '/api/' + name + '/1'
        , json: {id: 1, invalid: true}
      }, function(err, res, body){
        should.not.exist(err)
        res.statusCode.should.equal(422)
        body.message.should.equal('invalid!')
        collection.get(1).get('key').should.equal('not updated')
        done()
      })
    })

    it('deletes', function(done){
      var name = 'deletes'
        , collection = setup(name)
        , id = collection.last().id

      request.del({
        url: 'http://localhost:' + port + '/api/' + name + '/' + id
        , json: true
      }, function(err, res, body){
        should.not.exist(err)
        should.not.exist(body)
        should.not.exist(cache['/api/' + name + '/' + id])
        should.not.exist(collection.get(id))
        done()
      })
    })
  })

  describe('basic permissions', function(){
    var isBlocked = function(method, done){
        var id = ''
        if (method === 'put' || method === 'del') id = permCollection.last().id

        request[method]({
          url: 'http://localhost:' + port + '/permCollection/' + id
          , json: {key: 'I should be blocked'}
        }, function(err, res, body){
          should.not.exist(err)

          res.statusCode.should.equal(403)
          expect(body.code).to.equal(403)
          should.not.exist(permCollection.findWhere({key: 'I should be blocked'}))
          permCollection.length.should.equal(1)
          done()
        })
      }
      , PermCollection = Backbone.Collection.extend({
        url: '/permCollection'
      })
      , permCollection = new PermCollection({id: 1, key: 'not affected'})

    afterEach(function(){
      app.router.routes = {}
    })

    it('blocks access to create', function(done){
      new Resource(permCollection, {
        app: app
        , permissions: function(){
          return ['read', 'update', 'del']
        }
      })
      isBlocked('post', done)
    })

    it('blocks access to read', function(done){
      new Resource(permCollection, {
        app: app
        , permissions: function(){
          return ['create', 'update', 'del']
        }
      })
      isBlocked('get', done)
    })

    it('blocks access to update', function(done){
      new Resource(permCollection, {
        app: app
        , permissions: function(){
          return ['create', 'read', 'del']
        }
      })
      isBlocked('put', done)
    })

    it('blocks access to delete', function(done){
      new Resource(permCollection, {
        app: app
        , permissions: function(){
          return ['create', 'read', 'update']
        }
      })
      isBlocked('del', done)
    })

    after(function(){
      permCollection.reset()
    })
  })

  describe('complex permissions', function(){
    var PermFilterCollection = Backbone.Collection.extend({
        url: '/permFilterCollection'
      })
      , permFilterCollection = new PermFilterCollection()

    before(function(){
      _.each([1,2,3,4,5,6,7,8,9,10], function(i){
        permFilterCollection.add({id: (100 + i), key: 'value ' + i})
      })
    })
    afterEach(function(){
      app.router.routes = {}
    })

    it('reduces on reading a collection', function(done){
      new Resource(permFilterCollection, {
        app: app
        , permissions: function(){
          return {
            read: function(collection){
              return _.filter(collection, function(model){
                return model.id % 2
              })
            }
          }
        }
      })

      request.get({
        url: 'http://localhost:' + port + '/permFilterCollection'
        , json: true
      }, function(err, res, body){
        expect(err).to.not.exist

        res.statusCode.should.equal(200)
        body.length.should.equal((permFilterCollection.length / 2))
        done()
      })
    })

    it('rejects reading a reading a model that is not permitted', function(done){
      new Resource(permFilterCollection, {
        app: app
        , permissions: function(){
          return {
            read: function(collection){
              return _.filter(collection, function(model){
                return model.id % 2
              })
            }
          }
        }
      })

      request.get({
        url: 'http://localhost:' + port + '/permFilterCollection/102'
        , json: true
      }, function(err, res, body){
        expect(err).to.not.exist

        expect(res.statusCode).to.equal(403)
        expect(body.code).to.equal(403)
        done()
      })
    })

    it('rejects a create based on a filter', function(done){
      new Resource(permFilterCollection, {
        app: app
        , permissions: function(){
          return {
            create: function(collection, body){
              if (body.value === 'reject me!') return false
              else return true
            }
          }
        }
      })

      request.post({
        url: 'http://localhost:' + port + '/permFilterCollection'
        , json: {value: 'reject me!'}
      }, function(err, res, body){
        expect(err).to.not.exist

        expect(res.statusCode).to.equal(403)
        expect(body.code).to.equal(403)
        done()
      })
    })

    it('rejects an update based on a filter', function(done){
      new Resource(permFilterCollection, {
        app: app
        , permissions: function(){
          return {
            update: function(collection, body){
              if (body.value === 'reject me!') return false
              else return true
            }
          }
        }
      })

      request.put({
        url: 'http://localhost:' + port + '/permFilterCollection/101'
        , json: {value: 'reject me!'}
      }, function(err, res, body){
        expect(err).to.not.exist

        expect(res.statusCode).to.equal(403)
        expect(body.code).to.equal(403)
        done()
      })
    })

    it('rejects a delete based on a filter', function(done){
      new Resource(permFilterCollection, {
        app: app
        , permissions: function(){
          return {
            del: function(model){
              if (model.id === 101) return false
              else return true
            }
          }
        }
      })

      request.del({
        url: 'http://localhost:' + port + '/permFilterCollection/101'
        , json: true
      }, function(err, res, body){
        expect(err).to.not.exist

        expect(res.statusCode).to.equal(403)
        expect(body.code).to.equal(403)
        done()
      })

    })
  })

  describe('config', function(){
    it('can find the collection name from regex', function(){
      var NameTest = Backbone.Collection.extend({
          url: '/api/v1/nameTest'
        })
        , nameTest = new NameTest()
        , nameResource = new Resource(nameTest, {
          app: app
          , nameRegEx: /^\/api\/v1\/(.*)/
        })
      nameResource.name.should.equal('nameTest')
    })

    it('filters a collection', function(done){
      var FilterCollection = Backbone.Collection.extend({
          url: '/filterCollection'
        })
        , filterCollection = new FilterCollection({id: 1, key: 'a value'})

      ;new Resource(filterCollection, {
        app: app
        , filter: function(coll){
          _.each(coll, function(model){
            model.id = 'i changed you!'
          })
          return coll
        }
      })

      request.get({
        url: 'http://localhost:' + port + '/filterCollection/'
        , json: true
      }, function(err, res, body){
        should.not.exist(err)

        body[0].id.should.equal('i changed you!')
        filterCollection.get(1).id.should.equal(1)
        done()
      })
    })

    it('picks from a model', function(done){
      var PickCollection = Backbone.Collection.extend({
          url: '/pick'
        })
        , pickCollection = new PickCollection({id: 1, key: 'a value'})

      ;new Resource(pickCollection, {
        app: app
        , pick: function(model){
          return _.pick(model, 'key')
        }
      })

      request.get({
        url: 'http://localhost:' + port + '/pick/' + 1
        , json: true
      }, function(err, res, body){
        should.not.exist(err)

        should.not.exist(body.id)
        should.exist(body.key)
        body.key.should.equal('a value')
        done()
      })
    })
  })

  describe('server sent events', function(){
    function setup(url, id, options){
      var SSECollection = Backbone.Collection.extend({
          url: url
          , model: Backbone.Model.extend(options && options.model ? options.model : {})
        })
        , sseCollection = new SSECollection()
        , clientEvents
        , resource = new Resource(sseCollection, _.extend({app: app}, options || {}))

      // fake being a client that can receive sse events
      clientEvents = new EventSource('http://localhost:' + port +
        path.join(url, id ? encodeURIComponent(id) : '', '/subscribe'))

      return {clientEvents: clientEvents, collection: sseCollection, resource: resource}
    }

    describe('monitoring a whole collection', function(){
      it('sends an event when a model is added', function(done){
        var config = setup('/sse-adds')
          , clientEvents = config.clientEvents
          , collection = config.collection

        clientEvents.addEventListener('add', function(e){
          expect(JSON.parse(e.data).id).to.equal(1)
          clientEvents.close()
          done()
        })

        clientEvents.on('open', function(){
          collection.add({id: 1, value: 'added'})
        })

        clientEvents.onerror = function(e){
          expect(e).to.not.exist
        }
      })

      it('sends an event when a model is changed', function(done){
        var config = setup('/sse-changes')
          , clientEvents = config.clientEvents
          , collection = config.collection

        clientEvents.addEventListener('change', function(e){
          expect(JSON.parse(e.data).id).to.equal(2)
          expect(JSON.parse(e.data).value).to.equal('changed')
          clientEvents.close()
          done()
        })

        clientEvents.on('open', function(){
          collection.add({id: 2, value: 'added'})
          collection.get(2).save('value', 'changed')
        })

        clientEvents.onerror = function(e){
          expect(e).to.not.exist
        }
      })

      it('sends an event when a model is removed', function(done){
        var config = setup('/sse-remove')
          , clientEvents = config.clientEvents
          , collection = config.collection

        clientEvents.addEventListener('remove', function(e){
          expect(JSON.parse(e.data).id).to.equal(3)
          clientEvents.close()
          done()
        })

        clientEvents.on('open', function(){
          collection.add({id: 3, value: 'added'})
          collection.remove(3)
        })

        clientEvents.onerror = function(e){
          expect(e).to.not.exist
        }
      })

      it('sends an event when a model is destroyed', function(done){
        var config = setup('/sse-destroy')
          , clientEvents = config.clientEvents
          , collection = config.collection

        clientEvents.addEventListener('remove', function(e){
          expect(JSON.parse(e.data).id).to.equal(3)
          clientEvents.close()
          done()
        })

        clientEvents.on('open', function(){
          collection.add({id: 3, value: 'added'})
          collection.get(3).destroy()
        })

        clientEvents.onerror = function(e){
          expect(e).to.not.exist
        }
      })

      it('handles complex permission filtering', function(done){
        var config = setup('/sse-permissions', null, {
            permissions: {
              read: function(coll){
                // let's just pretend only odd numbered models are permissible
                return _.filter(coll, function(model){
                  return model.id % 2
                })
              }
            }
          })
          , clientEvents = config.clientEvents
          , collection = config.collection
          , complete = _.after(4, function(){
            clientEvents.close()
            done()
          })

        clientEvents.addEventListener('add', function(e){
          // id should be odd
          expect(JSON.parse(e.data).id % 2).to.equal(1)
          complete()
        })

        clientEvents.addEventListener('change', function(e){
          // id should be odd
          expect(JSON.parse(e.data).id % 2).to.equal(1)
          expect(JSON.parse(e.data).value).to.equal('changed')
          complete()
        })

        clientEvents.addEventListener('remove', function(e){
          // id should be odd
          expect(JSON.parse(e.data).id % 2).to.equal(1)
          complete()
        })

        clientEvents.on('open', function(){
          collection.add({id: 1, value: 'added'})
          collection.add({id: 2, value: 'added'})
          collection.add({id: 3, value: 'added'})
          collection.add({id: 4, value: 'added'})
          collection.get(3).save({value: 'changed'}, {
            success: function(){
              collection.get(3).destroy()
            }
          })
        })

        clientEvents.onerror = function(e){
          console.log(e)
          expect(e).to.not.exist
        }
      })

      it('handles simple whitelist permissions', function(done){
        var config = setup('/sse-permissions-simple', null, {
            permissions: ['read']
          })
          , clientEvents = config.clientEvents
          , collection = config.collection
          , complete = _.after(4, function(){
            clientEvents.close()
            done()
          })

        clientEvents.addEventListener('add', function(e){
          expect(JSON.parse(e.data).id).to.exist
          complete()
        })

        clientEvents.addEventListener('change', function(e){
          expect(JSON.parse(e.data).value).to.equal('changed')
          complete()
        })

        clientEvents.addEventListener('remove', function(e){
          expect(JSON.parse(e.data).id).to.exist
          complete()
        })

        clientEvents.on('open', function(){
          collection.add({id: 1, value: 'added'})
          collection.add({id: 2, value: 'added'})
          collection.add({id: 3, value: 'added'})
          collection.add({id: 4, value: 'added'})
          collection.get(3).save({value: 'changed'}, {
            success: function(){
              collection.get(3).destroy()
            }
          })
        })

        clientEvents.onerror = function(e){
          console.log(e)
          expect(e).to.not.exist
        }
      })

      it('handles simple blacklist permissions', function(done){
        var config = setup('/sse-permissions-simple-blacklist', null, {
            // not permitted
            permissions: []
          })
          , clientEvents = config.clientEvents

        clientEvents.onerror = function(e){
          expect(e).to.equal('Access denied')
          done()
        }
      })
    })

    describe('monitoring a single model', function(){
      it('sends an event when a model is changed', function(done){
        var config = setup('/sse-model-changes', 1)
          , clientEvents = config.clientEvents
          , collection = config.collection

        collection.add({id: 1, value: 'added'})

        clientEvents.addEventListener('change', function(e){
          expect(JSON.parse(e.data).id).to.equal(1)
          expect(JSON.parse(e.data).value).to.equal('changed')
          clientEvents.close()
          done()
        })

        clientEvents.on('open', function(){
          collection.get(1).save('value', 'changed')
        })

        clientEvents.onerror = function(e){
          expect(e).to.not.exist
        }
      })

      it('sends an event when a model is destroyed', function(done){
        var config = setup('/sse-model-destroy', 3, null)
          , clientEvents = config.clientEvents
          , collection = config.collection

        collection.add({id: 3, value: 'added'})

        clientEvents.addEventListener('destroy', function(e){
          expect(JSON.parse(e.data).id).to.equal(3)
          clientEvents.close()
          done()
        })

        clientEvents.on('open', function(){
          collection.get(3).destroy()
        })

        clientEvents.onerror = function(e){
          expect(e).to.not.exist
        }
      })

      it('handles complex permission filtering', function(done){
        var config = setup('/sse-model-permissions', 1, {
            permissions: {
              read: function(coll){
                // let's just pretend only odd numbered models are permissible
                return _.filter(coll, function(model){
                  return model.id % 2
                })
              }
            }
          })
          , clientEvents = config.clientEvents
          , collection = config.collection
          , complete = _.after(2, function(){
            clientEvents.close()
            done()
          })

        collection.add({id: 1, value: 'added'})
        collection.add({id: 2, value: 'added'})

        clientEvents.addEventListener('change', function(e){
          // id should be odd
          expect(JSON.parse(e.data).id % 2).to.equal(1)
          expect(JSON.parse(e.data).value).to.equal('changed')
          complete()
        })

        clientEvents.addEventListener('destroy', function(e){
          // id should be odd
          expect(JSON.parse(e.data).id % 2).to.equal(1)
          complete()
        })

        clientEvents.on('open', function(){
          collection.get(2).save({value: 'changed'})
          collection.get(1).save({value: 'changed'}, {
            success: function(){
              collection.get(1).destroy()
            }
          })
        })

        clientEvents.onerror = function(e){
          expect(e).to.not.exist
        }
      })

      it('handles simple whitelist permissions', function(done){
        var config = setup('/sse-model-permissions-simple', 1, {
            permissions: ['read']
          })
          , clientEvents = config.clientEvents
          , collection = config.collection
          , callCount = 0
          , complete = function(){
            if (callCount !== 2) return

            clientEvents.close()
            done()
          }

        collection.add({id: 1, value: 'added'})
        collection.add({id: 2, value: 'added'})

        clientEvents.addEventListener('change', function(e){
          var data = JSON.parse(e.data)

          expect(data.id).to.exist
          expect(data.value).to.equal('changed')

          if (data.id === 1) {
            callCount++
            complete()
          }
        })

        clientEvents.addEventListener('destroy', function(e){
          var data = JSON.parse(e.data)
          expect(data.id).to.exist

          if (data.id === 1) {
            callCount++
            complete()
          }
        })

        clientEvents.on('open', function(){
          collection.get(2).save({value: 'changed'})
          collection.get(1).save({value: 'changed'}, {
            success: function(){
              collection.get(1).destroy()
            }
          })
        })

        clientEvents.onerror = function(e){
          console.error(e)
          expect(e).to.not.exist
        }
      })

      it('handles simple blacklist permissions', function(done){
        var config = setup('/sse-model-permissions-simple-blacklist', 1, {
            // not permitted
            permissions: []
          })
          , clientEvents = config.clientEvents
          , collection = config.collection

        collection.add({id: 1})

        clientEvents.onerror = function(e){
          expect(e).to.equal('Access denied')
          done()
        }
      })
    })

    it('closes the SSE connection on browser disconnect', function(done){
      var config = setup('/sse-disconnect')
        , clientEvents = config.clientEvents
        // , collection = config.collection

      sinon.spy(app.log, 'debug')

      clientEvents.on('open', function(){
        clientEvents.close()
        // delay long enough for the server to react to the close
        setTimeout(function(){
          expect(app.log.debug.secondCall.args[0]).to.equal('resource: sse: client disconnect:')
          app.log.debug.restore()
          done()
        }, 5)
      })

      clientEvents.onerror = function(e){
        expect(e).to.not.exist
      }

    })

    it('handles permisssions without a standard id attribute', function(done){
      var config = setup('/sse-idAttribute', null, {model: {idAttribute: '_id'}})
        , clientEvents = config.clientEvents
        , collection = config.collection

      clientEvents.addEventListener('change', function(e){
        expect(JSON.parse(e.data)._id).to.equal(2)
        expect(JSON.parse(e.data).value).to.equal('changed')
        clientEvents.close()
        done()
      })

      clientEvents.on('open', function(){
        collection.add({_id: 2, value: 'added'})
        collection.get(2).save('value', 'changed')
      })

      clientEvents.onerror = function(e){
        expect(e).to.not.exist
      }
    })
  })

  describe('url params', function(){
    var config
      , url = '/params'
      , data = [
        {id: 1, value1: 'id1: 1', value2: 'id1: 2', integer: 3, dec: 4.5}
        , {id: 2, value1: 'id2: 1', value2: 'id2: 2'}
      ]

    function setup(url, data, options){
      var Collection = Backbone.Collection.extend({
          url: url
          , model: Backbone.Model.extend({})
        })
        , collection = new Collection(data)
        , resource = new Resource(collection, _.extend({app: app}, options || {}))

      return {collection: collection, resource: resource}
    }

    before(function(){
      config = setup(url, data)
    })

    it('filters attributes for a model GET on `?pick`', function(done){
      request({
        url: 'http://' + path.join('localhost:' + port, url, '/1')
        , json: true
        , qs: {
          pick: 'value1'
        }
      }, function(err, res, body){
        expect(err).to.not.exist
        expect(body).to.deep.equal(_.pick(data[0], 'value1'))
        done()
      })
    })

    it('filters attributes for a model GET on `?omit`', function(done){
      request({
        url: 'http://' + path.join('localhost:' + port, url, '/1')
        , json: true
        , qs: {
          omit: 'value1'
        }
      }, function(err, res, body){
        expect(err).to.not.exist
        expect(body).to.deep.equal(_.omit(data[0], 'value1'))
        done()
      })
    })

    it('filters attributes for a collection GET on `?pick`', function(done){
      request({
        url: 'http://' + path.join('localhost:' + port, url)
        , json: true
        , qs: {
          pick: 'value1'
        }
      }, function(err, res, body){
        expect(err).to.not.exist
        expect(body).to.deep.equal(data.map(function(model){
          return _.pick(model, 'value1')
        }))
        done()
      })
    })

    it('filters attributes for a collection GET on `?omit`', function(done){
      request({
        url: 'http://' + path.join('localhost:' + port, url)
        , json: true
        , qs: {
          omit: 'value1'
        }
      }, function(err, res, body){
        expect(err).to.not.exist
        expect(body).to.deep.equal(data.map(function(model){
          return _.omit(model, 'value1')
        }))
        done()
      })
    })

    it('filters attributes for a collection GET on `?whereValue` with an int', function(done){
      request({
        url: 'http://' + path.join('localhost:' + port, url)
        , json: true
        , qs: {
          whereKey: 'id'
          , whereValue: 2
        }
      }, function(err, res, body){
        expect(err).to.not.exist
        expect(body).to.deep.equal(_.where(data, {id: 2}))
        done()
      })
    })

    it('filters attributes for a collection GET on `?whereValue` with a float', function(done){
      request({
        url: 'http://' + path.join('localhost:' + port, url)
        , json: true
        , qs: {
          whereKey: 'dec'
          , whereValue: 4.5
        }
      }, function(err, res, body){
        expect(err).to.not.exist
        expect(body).to.deep.equal(_.where(data, {dec: 4.5}))
        done()
      })
    })

    it('filters attributes for a collection GET on `?whereValue` with a string', function(done){
      request({
        url: 'http://' + path.join('localhost:' + port, url)
        , json: true
        , qs: {
          whereKey: 'value1'
          , whereValue: 'id1: 1'
        }
      }, function(err, res, body){
        expect(err).to.not.exist
        expect(body).to.deep.equal(_.where(data, {value1: 'id1: 1'}))
        done()
      })
    })
  })

  after(function(done){
    cache = {}
    app.server.close()
    done()
  })
})

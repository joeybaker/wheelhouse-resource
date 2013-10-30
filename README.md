Wheelhouse Resource
===================

[![NPM](https://nodei.co/npm/wheelhouse-resource.png)](https://nodei.co/npm/wheelhouse-resource/)

Like [flatiron/restful](https://github.com/flatiron/restful), but swaps the dependency on [flatiron/resourceful](https://github.com/flatiron/resourceful) for server-side [Backbone](https://github.com/jashkenas/backbone) that is the standard with Wheelhouse. Also provides access permissions, output filtering, and Server Sent Events.

## Things to note
* This is intended work with server-side Backbone.js. You'll need to overwrite `Backbone.sync` to it to communicate with a data store. This Backbone should live at `app.Backbone`. e.g. [joeybaker/wheelhouse-couch](https://github.com/joeybaker/wheelhouse-couch)
* Backbone data is pulled from the datastore (unless there are already models in the collection) on resource creation and stored in memory. This has the potential to cause your process to run out of RAM on a large amount of data.
* By default, Node has a very small number of max connections (5), this overwrites that with a configurable number (1000 by default) so that many clients can stay connected to a SSE stream. Though this means many sockets are open, the actual traffic the app sees is signficantly less then using long-polling.

## Usage

```js
// assumes that you've overridden Backbone.Sync to save to your datastore.
var flatiron = require('flatiron')
  , app = flatiron.app
  , Collection = Backbone.Collection.extend({
    url: '/api/collection'
  })
  , collection = new Collection()
  , Resource = require('wheelhouse-resource')
  , resource = new Resource(collection, {
    app: app // required
    // optional
    , nameRegEx: /\/api\/(.*)/ // the default is to assume that the collection's url is used to name collection, if your collection's name doesn't match the url, the first match of this regex will be used to pull the name from the url
    , permissions: function(collection){
      // return an array with 'create', 'read', 'update', and/or 'del'
      // the context is a flatiron-style request
      if (this.req.user) return ['create', 'read', 'update', 'del']
      else return ['read']
    }
    , filter: function(collectionJSON){
      // read requests for a whole collection will filter through here.
      // useful for removing or adding attributes to the outputed JSON
      collectionJSON.forEach(function(model){
        delete model._private
      })
      return collectionJSON
    }
    , pick: function(modelJSON){
      // just like
    }
    , maxSockets: 1000 // default. Set to a high value so that Server Sent Events can connect to many clients
  })


```

### Complex Permissions
In order to create complex permissions, you can return an object from the permissions option. The keys are the CRUD values are functions that have the request context, with the collection or model and request body as arguments.

```js
…
, permissions: {
  read: function(collectionJSON){
    // from read, return an array of of models that are permissible
    return _.filter(collectionJSON, function(model){
      return model.readable === true
    })
  }
  // data is the incoming data from the POST request
  , create: function(collectionJSON, data){
    // return a boolean
    if (data.value === 'yup') return true
  }
  , update: function(modelJSON, data){
    // return a boolean
    if (data.value === 'yup') return true
  }
  , del: function(modelJSON){
    // return a boolean
    if (this.req.user.admin === true) return true
  }
}
…
```

## REST routes created

| Method  | Route                     | Response
|---------|---------------------------|---------------------------|
| GET     | /{collection.url}         | collection in JSON        |
| GET     | /{collection.url}/*       | model in JSON
| POST    | /{collection.url}         | create a new model, save to datastore and in memory
| PUT     | /{collection.url}/*       | update a model
| DELETE  | /{collection.url}/*       | delete a model
| GET     | /{collection.url}/subscribe | Server Sent Events for a whole collection |
| GET     | /{collection.url}/{id}/subscribe | Server Sent Events for a model |

## Server Sent Events

Subscribe to a collection or model to receive subsequent updates without necessitating long-polling.

These routes are subject to the 'read' permissions. If the client wouldn't be able to access the route via a `GET` request, they won't be able to access the SSE stream.

```js
// if the server has a resource created for "dogs"

// client-side code

  // listen to a whole collection
  clientEvents = new EventSource('http://example.com/dogs/subscribe')

  clientEvents.addEventListener('add', function(e){
    console.log(JSON.parse(e.data))
  })
  clientEvents.addEventListener('change', function(e){
    console.log(JSON.parse(e.data))
  })
  clientEvents.addEventListener('remove', function(e){
    console.log(JSON.parse(e.data))
  })


  // listen to a single model
  clientEvents = new EventSource('http://example.com/dogs/1/subscribe')

  clientEvents.addEventListener('change', function(e){
    console.log(JSON.parse(e.data))
  })
  clientEvents.addEventListener('destroy', function(e){
    console.log(JSON.parse(e.data))
  })
```

### Why not websockets?
Websockets are good, but answer different problems.

* Websockets are an alternative to HTTP REST. Both solutions offer two-way client-server communications. The point of this module is to provide HTTP REST. So… yea.
* SSE is significantly lighter-weight and more reliable than websockets.

## Tests

Mocha tests.

```shell
npm test
```

## Changelog

### 0.2.1 SSE keepAlive
SSE now sends keepalive events to prevent the client from timing out.

### 0.2 SSE
* adds Server Sent Events for models and collections
* SSE is permissions aware (based on `read` permissions)

### 0.1 Inital
* creates CRUD routes for a given collection
* has simple and complex permissions

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
    , assignRoutes: true // default. Set to false to manually assign routes.
    , hooks: { // optional, you can define hooks to modify the data
      read: function(collection, done){
        // called after filter, pick, and permissions have been run
        // called in the router context (`this.req`)
        // e.g.…

        app.db.get('something', function(err, res){
          var modifiedCollection = collection.map(function(model){
            model.newValue = res
          })
          // you must call the callback with the modified collection
          done(modifiedCollection)
        })
      }
    }
    // there are currently no hooks for create, update, del
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
  , create: function(collectionJSON){
    // return a boolean
    if (this.req.body.value === 'yup') return true
  }
  , update: function(modelJSON){
    // return a boolean
    if (this.req.body.value === 'yup') return true
  }
  , del: function(modelJSON){
    // return a boolean
    if (this.req.user.admin === true) return true
  }
}
…
```

### `assignRoutes()`
Allows you to delay the loading of the routes so that you can have a chance to modify the route's behavior. This might be useful if you'd like to perform an action before any model of a collection is updated.

```js
var Resource = require('wheelhouse-resource')
  , resource = new Resource(collection, {app: app, assignRoutes: false})

// by way of example: override the update method to lower case all names
resource.update = function(){
  this.req.data.name = this.req.data.name.toLowerCase()
  // You'll almost certianlly want to call the protoype method after you're done to take advantage of permissions, error handling, etc…
  Resource.prototype.update.call(this)
}

// after you've overwritten your methods, assign the routes.
resource.assignRoutes()
```

## Modifying the returned data via urls

### `?omit` and `?pick`
Passing a `omit` or `pick` query to the url with a comma separated list of values will limit the data returned.

e.g. `curl http://localhost:8000/collection/url?pick=id,car` will return just the `id` and `car` values of the models in the collection

[`omit`](http://lodash.com/docs#omit) is the inverse of [`pick`](http://lodash.com/docs#pick), it will return the whole model with the exception of the values passed.

Putting the same value in both `pick` and `omit` will cause the value to be ommitted. Put another way: `omit` overrides `pick`.

### `?whereKey` with `&whereValue`
Performs a [`_.where`](http://lodash.com/docs#where) lookup on a GET request for a collection. This is a good way to filter down the results. Perhaps even limit to a specific id.

`curl http://localhost:8000/collection/url?whereKey=_id&whereValue=2`

Returns an array of matches

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

### 0.2.28
`whereValue` can be a boolean.

### 0.2.27
**Fixed** `?whereValue` can now be a string and start with a number.

### 0.2.25
Use the pre-parsed querystring instead of trying to parse it ourselves.

### 0.2.24
* fixes critical error in 0.2.23 with update validation

### 0.2.23
* updates and creates now handle model validation failures by returning a 422

### 0.2.22
**new** add `?whereKey=&whereValue=` filtering options for GET requests on a collection.

### 0.2.21
* **new** allow routes to not be assigned automatically on resource init by passing the `assignRoutes: false` in the options. You can then assign them with `resource.assignRoutes()`. This is handy if you want to override the CRUD methods.
* only listen to the SSE connection `once` for a close event.

### 0.2.20
* Rather than passing the raw `res.response` object to SSEClient, patch flatiron's lack of `'close'` event. This allows us to use the flatiron `this.res` object which might have handy methods.
* Bug fix: Previously, only models with an `idAttribute` of `id` would get through permissions filtering.

### 0.2.19
Minor cleanup. Now throwing errors if Resouce isn't passed necessary config options.

### 0.2.18
Fix flatiron silliness. SSE connections now close

### 0.2.17
Our hack for backbone-associations was `set`ing silently. This meant that change events and `previousAttributes()` would fail to work. This no longer sets silently. Apparently, to no ill effect.

### 0.2.16
* querystring are no longer considered to be a valid part of the collection's name. This means that if your collection urls were depending on query strings, they'll break.
* it's now possible to pass `omit` and `pick` params in the url to respectively limit the returned data.

### 0.2.14 Cleaner SSE implementation
Uses the SSE client directly so that we can go through `app.router`. This fixes all kinds of things …like permissions. Thanks @kkesha!

### 0.2.1 SSE keepAlive
SSE now sends keepalive events to prevent the client from timing out.

### 0.2 SSE
* adds Server Sent Events for models and collections
* SSE is permissions aware (based on `read` permissions)

### 0.1 Inital
* creates CRUD routes for a given collection
* has simple and complex permissions

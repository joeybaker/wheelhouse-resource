Wheelhouse Resource
===================

[![NPM](https://nodei.co/npm/wheelhouse-resource.png)](https://nodei.co/npm/wheelhouse-resource/)

Like [flatiron/restful](https://github.com/flatiron/restful), but swaps the dependency on [flatiron/resourceful](https://github.com/flatiron/resourceful) for server-side [Backbone](https://github.com/jashkenas/backbone) that is the standard with Wheelhouse. Also provides access permissions and output filtering.

## Things to note
* This is alpha.
* Dependency on backbone the server-side being overwritten to allow syncing to a data store. This Backbone should live at `app.Backbone`. e.g. [joeybaker/wheelhouse-couch](https://github.com/joeybaker/wheelhouse-couch)
* Backbone data is pulled from the datastore on resource creation and stored in memory. This has the potential to cause your process to run out of RAM on a large amount of data.
* Unless a new resource finds models in the collection in memory, it will attempt to fetch its data from the datastore on initialization.

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
    , permissions: function(){
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

## Tests

Mocha tests.

```shell
npm test
```

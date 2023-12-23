const { RspackDevServer } = require('@rspack/dev-server')
const rspack = require('@rspack/core')
const devConfig = require('./rspack.config')

async function start() {
  const compiler = rspack(devConfig)
  const devServerOptions = {
    hot: false,
    client: false,
    liveReload: false,
    host: 'localhost',
    port: 3000,
    open: false,
    devMiddleware: {
      stats: 'minimal'
    },
    allowedHosts: 'all',
    headers: {
      'Access-Control-Allow-Origin': '*'
    }
  }
  const server = new RspackDevServer(devServerOptions, compiler)
  await server.start()
}

start()

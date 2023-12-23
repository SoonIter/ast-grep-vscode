const rspack = require('@rspack/core')
const refreshPlugin = require('@rspack/plugin-react-refresh')
const isDev = process.env.NODE_ENV === 'development'
const { resolve } = require('path')

const devServerClientOptions = {
  hot: true,
  // !: 指定构造 WebSocket 的协议是 ws
  protocol: 'ws',
  hostname: 'localhost',
  port: 3000,
  path: 'ws'
}
const devServerClientQuery = Object.entries(devServerClientOptions)
  .map(([k, v]) => `${k}=${v}`)
  .join('&')

const webpackHotDevServer = resolve(__dirname, './webpack-hot-dev-server.js')
const devEntries = [
  webpackHotDevServer,
  `webpack-dev-server/client/index.js?${devServerClientQuery}`
]

/**@type {import('webpack').Configuration}*/
module.exports = {
  mode: 'development',
  entry: [...devEntries, resolve(__dirname, '../../src/webview/index.tsx')],
  output: {
    publicPath: 'http://localhost:3000/',
    path: resolve(__dirname, '../../out/webview/index.js'),
    filename: 'index.js'
  },
  resolve: {
    extensions: ['.js', '.ts', '.tsx', '.json']
  },
  module: {
    rules: [
      {
        test: /\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$/,
        exclude: /(node_modules|bower_components)/,
        loader: 'builtin:swc-loader',
        options: {
          sourceMap: true,
          jsc: {
            parser: {
              syntax: 'typescript',
              tsx: true
            },
            transform: {
              react: {
                runtime: 'automatic',
                development: isDev,
                refresh: isDev
              }
            }
          },
          env: {
            targets: [
              'chrome >= 87',
              'edge >= 88',
              'firefox >= 78',
              'safari >= 14'
            ]
          }
        }
      },
      {
        test: [/\.bmp$/, /\.gif$/, /\.jpe?g$/, /\.png$/, /\.svg$/],
        type: 'asset',
        parser: {
          dataUrlCondition: {
            maxSize: 10 * 1024
          }
        },
        generator: {
          filename: 'images/[hash]-[name][ext][query]'
        }
      }
    ]
  },
  devtool: 'eval-source-map',
  plugins: [
    new rspack.DefinePlugin({
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV)
    }),
    new rspack.ProgressPlugin({}),
    new rspack.HotModuleReplacementPlugin({}),
    isDev ? new refreshPlugin() : null
  ]
}

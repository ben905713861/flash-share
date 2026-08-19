const path = require("path");
const HtmlWebpackPlugin = require("html-webpack-plugin");

module.exports = {
  mode: "production",
  entry: "./src/main.tsx",
  output: {
    path: path.resolve(__dirname, "dist"),
    filename: "app.[contenthash].js",
    clean: true
  },
  devServer: {
    port: 8080,
    hot: true,
    liveReload: true,
    open: false,
    historyApiFallback: true,
    client: {
      overlay: true
    }
  },
  resolve: { extensions: [".tsx", ".ts", ".js"] },
  module: {
    rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: "ts-loader" }]
  },
  plugins: [new HtmlWebpackPlugin({ template: "./webrtc.html" })]
};

`node-LICENSE` is the complete upstream license file for the Node.js runtime
embedded in the image, including its third-party notices:

https://github.com/nodejs/node/blob/v24.21.0/LICENSE

Refresh this file when updating the Node version in Dockerfile. It is kept in
source because the official Alpine images do not install it at the same path
on every CPU architecture.

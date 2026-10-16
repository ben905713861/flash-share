1. install all dependencies
  `npm ci`

2. install workerd
  `npm install --save-dev workerd`

3. build project code
  `npx wrangler deploy --dry-run --outdir dist`
  file will be generated on `dist/index.js`

4. develop config.capnp

5. deploy privkey.pem and fullchain.pem

5. start workerd
  `npx workerd serve config.capnp`

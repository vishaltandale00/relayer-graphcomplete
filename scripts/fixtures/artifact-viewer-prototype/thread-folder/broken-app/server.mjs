// An app whose dev command fails, the way a missing dependency does.
console.log("> tidewater-loyalty@0.1.0 dev");
console.log("> vite --port 5181");
setTimeout(() => {
  console.error("Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'vite' imported from /tidewater-loyalty/node_modules/.bin/vite");
  console.error("    at packageResolve (node:internal/modules/esm/resolve:854:9)");
  console.error("Did you run `npm install`?");
  process.exit(1);
}, 600);

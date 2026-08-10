# Contributing

`rickydata-sdk` is the public source and release surface for the RickyData npm packages.

## Development

```bash
npm ci
npm run check:public
npm run build
npm test
npm run typecheck
```

Pull requests are welcome. Maintainers integrate accepted changes into the private development repository first, then regenerate this public source so the two repositories cannot drift.

Never commit credentials, local agent configuration, execution traces, development plans, generated tarballs, or absolute workstation paths.

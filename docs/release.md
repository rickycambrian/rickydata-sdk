# Release process

The private `rickydata_SDK` repository is the development source of truth. This public repository has independent history and is the only npm release surface.

## Prepare

1. Complete and verify the change on private `main`.
2. Bump every changed publishable workspace version. The `rickydata` version must match the release tag.
3. From a clean private checkout at `origin/main`, run:

   ```bash
   npm run sync:public -- --target ../rickydata-sdk
   ```

4. Review the complete public diff. The exporter never commits, pushes, tags, or publishes.
5. Commit the generated snapshot on a public release branch and open a pull request against public `main`.

## Publish

After protected public CI passes and the release PR is merged:

```bash
version="v$(node -p "require('./packages/core/package.json').version")"
git tag "$version"
git push origin "$version"
```

The release workflow verifies the tag and package contents, publishes only versions absent from npm, creates the GitHub release, then verifies registry metadata, fresh installation, ESM imports, CLI execution, and the RickyData production service health endpoints.

Publishing uses the `NPM_TOKEN` GitHub Actions repository secret, exposed only to the protected `npm-production` publish job. Use a granular npm token limited to package publishing and rotate it before expiry.

Never tag a version already present on npm, publish from the private repository, or copy private Git history into this repository.

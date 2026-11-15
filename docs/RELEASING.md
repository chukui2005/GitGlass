# Releasing GitGlass

GitGlass releases are prepared from a reviewed pull request. Do not publish directly from `main`.

## Windows beta build

```powershell
npm ci
npm run dist:win
```

The build creates these files in the ignored `release/` directory:

- `GitGlass-Setup-<version>-x64.exe`
- `GitGlass-<version>-win-x64.zip`
- `SHA256SUMS.txt`

Use `--publish never` for local validation. After the pull request is accepted, a maintainer can create the GitHub Release and attach the verified files. Do not create a tag or release as part of a packaging pull request.

// Layer rules of the frontend hexagon (docs/architecture.md §7), checked by `pnpm depcruise`.
//
//   contract        generated from OpenAPI; imports nothing of ours, every layer may import it
//   domain          pure TS over the snapshot: contract only, no packages
//   application     scenarios, store, subscription manager, ports: domain, contract, zustand
//   infrastructure  adapters: application, domain, contract; the only home of livekit-client
//   ui              React: application, domain, contract; never infrastructure
//   main.tsx        composition root: may import anything, nothing imports it
//
// Package paths are matched after pnpm's symlinks are resolved, hence `(^|/)node_modules/`.

const LAYERS = '(contract|domain|application|infrastructure|ui)'
const PACKAGE = '(^|/)node_modules/'
/** @param {string[]} names */
const pkg = (names) => `${PACKAGE}(@types/)?(${names.join('|')})/`

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      comment: 'Cycles blur the direction of dependencies between and inside layers.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'layered-or-composition-root',
      comment:
        'Every module lives in a layer; main.tsx is the composition root and nothing imports it.',
      severity: 'error',
      from: {},
      to: { path: '^src/', pathNot: `^src/${LAYERS}/` },
    },
    {
      name: 'contract-imports-nothing',
      comment: 'contract is generated from the backend OpenAPI and stands alone.',
      severity: 'error',
      from: { path: '^src/contract/' },
      to: { path: '^src/', pathNot: '^src/contract/' },
    },
    {
      name: 'domain-reads-only-contract',
      comment: 'domain is pure TS over the snapshot: no other layer.',
      severity: 'error',
      from: { path: '^src/domain/' },
      to: { path: '^src/', pathNot: '^src/(domain|contract)/' },
    },
    {
      name: 'domain-has-no-packages',
      comment: 'domain is pure TS: no React, Zustand, React Router, LiveKit or any other package.',
      severity: 'error',
      from: { path: '^src/domain/' },
      to: { path: PACKAGE },
    },
    {
      name: 'application-reads-domain-and-contract',
      comment: 'application reaches media and the API only through its ports.',
      severity: 'error',
      from: { path: '^src/application/' },
      to: { path: '^src/', pathNot: '^src/(application|domain|contract)/' },
    },
    {
      name: 'application-uses-only-zustand',
      comment: 'application knows neither React nor LiveKit; its only package is Zustand.',
      severity: 'error',
      from: { path: '^src/application/' },
      to: { path: PACKAGE, pathNot: pkg(['zustand']) },
    },
    {
      name: 'infrastructure-serves-application',
      comment: 'infrastructure implements the ports of application and never renders.',
      severity: 'error',
      from: { path: '^src/infrastructure/' },
      to: { path: '^src/', pathNot: '^src/(infrastructure|application|domain|contract)/' },
    },
    {
      name: 'infrastructure-has-no-react',
      comment: 'infrastructure never renders: no React, React DOM or React Router.',
      severity: 'error',
      from: { path: '^src/infrastructure/' },
      to: { path: pkg(['react', 'react-dom', 'react-router']) },
    },
    {
      name: 'ui-never-reaches-infrastructure',
      comment: 'ui reads the store and calls scenarios; adapters are wired in main.tsx.',
      severity: 'error',
      from: { path: '^src/ui/' },
      to: { path: '^src/', pathNot: '^src/(ui|application|domain|contract)/' },
    },
    {
      name: 'media-and-api-clients-only-in-infrastructure',
      comment:
        'MediaSession is the single owner of subscriptions, tracks and volume; ' +
        'the API client is an adapter too.',
      severity: 'error',
      from: { path: '^src/', pathNot: ['^src/infrastructure/', '^src/main\\.tsx$'] },
      to: { path: pkg(['livekit-client', 'openapi-fetch']) },
    },
    {
      name: 'not-to-unresolvable',
      comment: 'An import that does not resolve would slip past every other rule.',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'no-non-package-json',
      comment: 'Packages used by the app are declared in package.json.',
      severity: 'error',
      from: {},
      to: { dependencyTypes: ['npm-no-pkg', 'npm-unknown'] },
    },
    {
      name: 'not-to-dev-dep',
      comment: 'The browser bundle does not depend on devDependencies.',
      severity: 'error',
      from: { path: '^src/' },
      to: { dependencyTypes: ['npm-dev'], dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'no-node-builtins',
      comment: 'This is browser code.',
      severity: 'error',
      from: { path: '^src/' },
      to: { dependencyTypes: ['core'] },
    },
  ],
  options: {
    doNotFollow: { path: PACKAGE },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.app.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
    },
  },
}

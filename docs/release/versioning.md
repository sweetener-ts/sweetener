# Versioning policy

The first staged release is `0.1.0-alpha.0`. Package versions follow SemVer.
Until `1.0.0`, public TypeScript API signatures may change in a minor release,
but every change still requires release notes and synchronized package versions.

Language behavior is versioned independently as language version `1`. Changes
to matching, capture shape, hygiene, phase lookup, expansion order, precedence,
or binding behavior require a new language version and migration note. Alpha
package status does not make those semantics implicit.

The macro-module manifest, origin map, fixture corpus, release specification,
and expansion trace begin at format/schema version `1`. Additive optional trace
fields may remain within schema 1. Removing, reinterpreting, or requiring a
field increments its schema. Readers must reject unsupported manifest versions
and may ignore unknown trace fields within a supported schema.

All publishable packages use one synchronized version, taken from the root
`package.json`. Internal workspace dependency ranges are rewritten to that exact
alpha version in staged manifests. Release tarballs are content-hashed in
`artifacts/release/release.json`.

Not every package in the workspace is published: eleven compiler layers ship
inside `@sweetener/compiler`, and the shared test harness is not published at
all. `scripts/release-packages.mjs` holds that division, and the release check
fails on a workspace package that is neither published, absorbed, nor
deliberately excluded.

Alpha succession uses `0.1.0-alpha.N`, which `npm version prerelease` produces.
A changed tarball is never republished under an existing version.

Registry publication uses the `latest` dist-tag, so `npm install @sweetener/cli`
gives the newest release. A publish sets one dist-tag, and moving another takes `npm dist-tag add`, which
npm's trusted publishing does not authorize
([npm/cli#8547](https://github.com/npm/cli/issues/8547)), so the workflow does
not maintain a second tag.

A prerelease also does not satisfy an ordinary range: `^0.1.0` does not match
`0.1.0-alpha.0`, and neither does `~0.1.0`. Only an exact version resolves one,
or a range carrying its own prerelease such as `^0.1.0-alpha.0`. Staged
manifests therefore pin internal dependencies to the exact version instead of a
caret range.

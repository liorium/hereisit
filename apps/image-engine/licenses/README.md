# License compliance review

The maintainer may perform and record this review. Hiring an external reviewer or belonging to an
organization is not required by this project's policy. `organization` is optional; existing review
records that include it remain valid. This supersedes the external-review requirement in historical
implementation plans, not the licenses of third-party components.

The existing `commercial-review` filenames and v1 record format remain for compatibility. A release
review must still bind the exact source-lock bytes and cover every production component's revision
and notice files. Record the actual reviewer, date, findings and approval reference. An example record,
an automatic test pass, or permission to simplify this process is not an approval of unreviewed code.

Use the existing inventory and license checks to verify the deployed libraries, dynamic linkage,
license notices, corresponding source and relinking materials required by the project policy. Assess
which license obligations apply to the actual hosting/distribution arrangement; do not assume a
server-only service and distribution of a binary have identical obligations. Obtain specialist advice
only when a material question remains unresolved.

Do not mark pending source records approved without completing their review. Unknown/prohibited
licenses, outstanding conditions, stale or mismatched evidence, and vulnerability checks remain
blocking. This change removes an organizational prerequisite; it does not waive license obligations,
approve security exceptions, or establish that a release is ready.

## Runtime package source

The image runtime uses Ubuntu 24.04 LTS packages from the fixed
`https://snapshot.ubuntu.com/ubuntu/20260918T000000Z/` archive. Native libraries are built against
that same distribution. The final shell-free image copies only their runtime dependencies, the
official Node binary, certificate bundle, locale data, and application files; it does not combine
Debian's libc with Ubuntu libraries or maintain a private libc patch.

`/build-metadata/debian-packages.json` retains its existing filename for dpkg-format compatibility.
It records the exact copied package versions; `/var/lib/dpkg/status.d` and `/etc/os-release` preserve
the package and Ubuntu identities for vulnerability scanners. Copyright notices are under
`/usr/share/doc/<package>/copyright`; the Node distribution's complete license notice is under
`/licenses/node/LICENSE`. Retrieve corresponding Ubuntu source by enabling `deb-src` for the same
snapshot and running `apt-get source <source-package>=<source-version>` using the `Source` and
`Version` fields in the retained package records. Native source revisions and build instructions
remain in `native/sources.lock.json` and `native/build-*.sh`.

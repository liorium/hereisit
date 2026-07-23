# Processing evidence signing key ceremony

HereIsIt release evidence uses an offline Ed25519 private key. The private key is a maintainer-held
release credential: it must never enter this repository, GitHub Actions, Cloudflare, an Actions
artifact, a shell argument, or a command log. Only the public key and its reviewed fingerprint may be
committed.

Do this ceremony on the trusted maintainer workstation immediately before the first signed processing
release. Do not generate the production key in a disposable CI runner or in this development container.

## Generate and back up the key

Choose an external directory owned by the maintainer. The signing code refuses a private-key path
inside the repository, a symbolic link, a non-regular file, a non-Ed25519 key, or permissions other
than `0600`.

```bash
set -euo pipefail
umask 077
install -d -m 0700 "$HOME/.config/hereisit"
openssl genpkey \
  -algorithm Ed25519 \
  -out "$HOME/.config/hereisit/release-evidence-ed25519.pem"
chmod 0600 "$HOME/.config/hereisit/release-evidence-ed25519.pem"
openssl pkey \
  -in "$HOME/.config/hereisit/release-evidence-ed25519.pem" \
  -pubout \
  -out "$HOME/.config/hereisit/release-evidence-ed25519-public.pem"
```

Before using the key, place one encrypted backup in a maintainer-controlled secrets manager or
offline encrypted volume. Verify that the backup restores to the same public-key fingerprint, then
remove any unencrypted temporary copies. Loss of the only private-key copy must stop releases; it is
not a reason to bypass signature verification.

## Review and commit only the public key

Compute the fingerprint from the public SubjectPublicKeyInfo DER bytes:

```bash
openssl pkey \
  -pubin \
  -in "$HOME/.config/hereisit/release-evidence-ed25519-public.pem" \
  -outform DER \
  | openssl dgst -sha256
```

Copy only the public PEM to
`docs/deployment/processing-evidence-ed25519-public.pem`. Review the key type and fingerprint in the
pull request. The private-key environment variable used by the local evidence creator is a path, not
key material:

```bash
export HEREISIT_RELEASE_EVIDENCE_PRIVATE_KEY_FILE="$HOME/.config/hereisit/release-evidence-ed25519.pem"
```

Never print, base64-encode into a workflow, or add that file to Git. Before signing, confirm that
`git check-ignore` does not matter because the private key is physically outside the repository.

The repository intentionally has no production public-key file until this ceremony is completed on
the trusted maintainer workstation. After the reviewed public PEM is copied to the path above, verify
each detached signature before deployment with the existing fail-closed CLI:

```bash
: "${RELEASE_ID:?set the immutable YYYY-MM-DD.N release ID}"
node scripts/processing-evidence-signature.mjs \
  --mode verify \
  --bundle ".artifacts/candidate/evidence-v1--$RELEASE_ID--processing-evidence.json" \
  --signature ".artifacts/candidate/evidence-v1--$RELEASE_ID--processing-evidence.sig" \
  --public-key docs/deployment/processing-evidence-ed25519-public.pem
```

## Rotation and recovery

Key rotation is a reviewed release-chain change:

1. generate and back up a new external key using the same procedure;
2. commit the new public key and both old/new fingerprints in a dedicated pull request;
3. keep the verifier able to validate already-published evidence with the retired public key;
4. activate the new signing key only after the public-key change reaches production; and
5. record the first release ID signed by the new key and the final release ID signed by the old key.

Suspected private-key disclosure stops release promotion. Preserve public evidence and prior public
keys, rotate through a reviewed change, and never rewrite or re-sign an existing release ID.

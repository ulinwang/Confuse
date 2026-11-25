const visibilityToken =
  process.env.GHCR_VISIBILITY_TOKEN ?? process.env.GITHUB_TOKEN;
const version = process.env.CONFUSE_RELEASE_VERSION;
const namespace = "ulinwang";
const packageNames = ["confuse-web", "confuse-worker"];

if (!visibilityToken) {
  throw new Error("GITHUB_TOKEN is required to make release packages public");
}
if (
  !version ||
  !/^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$/.test(version)
) {
  throw new Error(`Invalid release version: ${version ?? "unset"}`);
}

async function makePublic(packageName) {
  const response = await fetch(
    `https://api.github.com/user/packages/container/${packageName}`,
    {
      method: "PATCH",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${visibilityToken}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ visibility: "public" }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Failed to make ghcr.io/${namespace}/${packageName} public (HTTP ${response.status})`,
    );
  }
  console.log(`Made ghcr.io/${namespace}/${packageName} public`);
}

async function anonymousManifest(packageName) {
  const tokenUrl = new URL("https://ghcr.io/token");
  tokenUrl.searchParams.set(
    "scope",
    `repository:${namespace}/${packageName}:pull`,
  );
  const tokenResponse = await fetch(tokenUrl);
  if (!tokenResponse.ok) {
    throw new Error(
      `Anonymous token request failed for ${packageName} (HTTP ${tokenResponse.status})`,
    );
  }
  const { token } = await tokenResponse.json();
  if (!token) {
    throw new Error(`Anonymous token response for ${packageName} has no token`);
  }

  const manifestResponse = await fetch(
    `https://ghcr.io/v2/${namespace}/${packageName}/manifests/${version}`,
    {
      headers: {
        Accept: [
          "application/vnd.oci.image.index.v1+json",
          "application/vnd.docker.distribution.manifest.list.v2+json",
        ].join(", "),
        Authorization: `Bearer ${token}`,
      },
    },
  );
  if (!manifestResponse.ok) {
    throw new Error(
      `Anonymous manifest request failed for ${packageName}:${version} (HTTP ${manifestResponse.status})`,
    );
  }
  const manifest = await manifestResponse.json();
  const platforms = new Set(
    (manifest.manifests ?? []).map(
      (entry) => `${entry.platform?.os}/${entry.platform?.architecture}`,
    ),
  );
  for (const platform of ["linux/amd64", "linux/arm64"]) {
    if (!platforms.has(platform)) {
      throw new Error(
        `Anonymous manifest for ${packageName}:${version} is missing ${platform}`,
      );
    }
  }
  console.log(
    `Verified anonymous AMD64 and ARM64 manifest access for ghcr.io/${namespace}/${packageName}:${version}`,
  );
}

for (const packageName of packageNames) {
  await makePublic(packageName);
}

for (const packageName of packageNames) {
  let lastError;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      await anonymousManifest(packageName);
      lastError = undefined;
      break;
    } catch (error) {
      lastError = error;
      if (attempt < 6) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }
  if (lastError) throw lastError;
}

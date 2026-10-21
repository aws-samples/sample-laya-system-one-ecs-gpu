// Prints "<repository> <tag>" for every Docker image asset in a CDK assets manifest.
const fs = require('fs');

const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
for (const asset of Object.values(manifest.dockerImages ?? {})) {
  for (const dest of Object.values(asset.destinations)) {
    const repo = dest.repositoryName.replace('${AWS::AccountId}', process.env.CDK_ACCOUNT ?? '')
      .replace('${AWS::Region}', process.env.AWS_REGION ?? '');
    console.log(`${repo} ${dest.imageTag}`);
  }
}

# Firebase Firestore rules deployment (GitHub OIDC)

This repository deploys only `firestore.rules` to the production Firebase project `masayfantasias`. It uses GitHub OIDC / Google Workload Identity Federation; no service-account JSON key is stored in GitHub.

## One-time Google Cloud setup

Run these commands as a Google Cloud project administrator with permission to manage Workload Identity Federation and service accounts. They create a narrowly scoped deployer identity. The provider accepts tokens only from this repository and deployment branch.

```bash
PROJECT_ID=masayfantasias
REPOSITORY=gusta3108-lab/masayfan-backend
POOL_ID=github-actions
PROVIDER_ID=github
SA_NAME=firebase-rules-deployer

PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
gcloud services enable iamcredentials.googleapis.com sts.googleapis.com --project "$PROJECT_ID"

gcloud iam workload-identity-pools create "$POOL_ID" \
  --project="$PROJECT_ID" --location=global \
  --display-name="GitHub Actions deployments"

gcloud iam workload-identity-pools providers create-oidc "$PROVIDER_ID" \
  --project="$PROJECT_ID" --location=global --workload-identity-pool="$POOL_ID" \
  --display-name="Masay backend repository" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
  --attribute-condition="assertion.repository == '$REPOSITORY' && assertion.ref == 'refs/heads/fix/verified-mercadopago-payments'"

gcloud iam service-accounts create "$SA_NAME" --project "$PROJECT_ID" \
  --display-name="GitHub Firestore rules deployer"
SA_EMAIL="$SA_NAME@$PROJECT_ID.iam.gserviceaccount.com"

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$SA_EMAIL" --role="roles/firebaserules.admin"
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$SA_EMAIL" --role="roles/serviceusage.serviceUsageConsumer"

gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
  --project="$PROJECT_ID" --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/$POOL_ID/attribute.repository/$REPOSITORY"
```

## One-time GitHub configuration

On the repository's **Settings → Secrets and variables → Actions → Variables**, add these repository variables:

- `GCP_WORKLOAD_IDENTITY_PROVIDER`: `projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github-actions/providers/github` (replace `PROJECT_NUMBER` with the value returned above).
- `FIREBASE_DEPLOY_SERVICE_ACCOUNT`: `firebase-rules-deployer@masayfantasias.iam.gserviceaccount.com`.

Create a GitHub Actions environment named `firebase-production` under **Settings → Environments**. Optionally add required reviewers there to gate production deployments.

## Operation

- The workflow can be started manually with **Actions → Deploy Firestore rules → Run workflow**.
- It also runs when `firestore.rules`, `firebase.json`, or this workflow changes on `fix/verified-mercadopago-payments`.
- It deploys rules only; it does not modify Firestore documents, customer records, orders, inventory, payments, hosting, or backend services.
- A successful workflow run is the confirmation of publication. Emulator tests remain separate and do not imply production deployment.

Do not create or upload a service-account private key. If the deployer identity or variables are missing, the workflow will fail closed without publishing.
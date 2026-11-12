# Publicación de reglas de Firebase Firestore mediante GitHub OIDC

Este repositorio publica únicamente el archivo `firestore.rules` en el proyecto Firebase de producción `masayfantasias`. La autenticación utiliza GitHub OIDC y la federación de identidades de Google (Workload Identity Federation). No se guarda ninguna clave JSON de cuenta de servicio en GitHub.

## 1. Configuración inicial en Google Cloud (se hace una sola vez)

Abre la consola de Google Cloud con una cuenta que tenga permisos de administración del proyecto y de creación de grupos de identidades federadas y cuentas de servicio.

1. Selecciona el proyecto `masayfantasias`.
2. Abre **Cloud Shell** (el icono de terminal en la parte superior de la consola).
3. Copia y ejecuta el bloque completo de comandos que aparece abajo. Estos comandos crean una identidad con permisos limitados. El proveedor aceptará tokens únicamente de este repositorio y de la rama autorizada.

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

**Importante:** si Cloud Shell indica que el grupo, proveedor o cuenta de servicio ya existe, no repitas los comandos de creación a ciegas. Detente y revisa el recurso existente antes de continuar. No compartas contraseñas, tokens ni claves privadas.

## 2. Configuración inicial en GitHub (se hace una sola vez)

Entra al repositorio [gusta3108-lab/masayfan-backend](https://github.com/gusta3108-lab/masayfan-backend).

1. Ve a **Settings → Secrets and variables → Actions → Variables**.
2. Pulsa **New repository variable** y crea estas dos variables:

| Nombre | Valor |
|---|---|
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github-actions/providers/github` |
| `FIREBASE_DEPLOY_SERVICE_ACCOUNT` | `firebase-rules-deployer@masayfantasias.iam.gserviceaccount.com` |

En la primera variable, reemplaza `PROJECT_NUMBER` por el número que devolvió el comando `gcloud projects describe` del paso 1. No escribas literalmente la palabra `PROJECT_NUMBER`.

3. Ve a **Settings → Environments** y crea un entorno llamado exactamente `firebase-production`. Puedes añadir revisores obligatorios si quieres que alguien apruebe cada publicación.

## 3. Ejecutar la publicación de reglas

1. Abre la pestaña **Actions** del repositorio.
2. Selecciona el flujo **Deploy Firestore rules**.
3. Pulsa **Run workflow** y confirma la ejecución en la rama `fix/verified-mercadopago-payments`.
4. Espera a que termine. La publicación solo se considera confirmada si la ejecución finaliza correctamente (**Success**, con marca verde).

El flujo también se ejecutará automáticamente cuando cambien `firestore.rules`, `firebase.json` o el propio archivo del flujo en la rama autorizada.

## Qué modifica y qué no modifica

Este flujo publica únicamente las reglas de seguridad de Firestore. No modifica documentos de Firestore, clientes, pedidos, inventario, pagos, alojamiento web ni servicios del backend. Las pruebas del emulador son independientes y no significan que las reglas ya estén publicadas en producción.

**No crees ni subas una clave privada JSON de la cuenta de servicio.** La autenticación federada evita tener que almacenar ese tipo de clave en GitHub. Si faltan la identidad federada o las variables, el flujo debe fallar sin publicar cambios.

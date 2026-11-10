# Masa y Fantasías — backend de pagos

Backend Express para crear preferencias de Mercado Pago y registrar pedidos únicamente después de verificar un pago aprobado.

## Variables de entorno en Render

Configurar en **Environment** del servicio:

- `MP_ACCESS_TOKEN`: Access Token privado de la aplicación de Mercado Pago. Mantenerlo únicamente en Render; nunca en el frontend ni en GitHub.
- `MP_WEBHOOK_SECRET`: clave de firma secreta de Webhooks de la aplicación de Mercado Pago.
- `FIREBASE_SERVICE_ACCOUNT_JSON`: contenido JSON completo de una cuenta de servicio de Firebase Admin con acceso al proyecto `masayfantasias`.

No compartir ni subir estos valores al repositorio.

## Configuración de Firebase

1. En Firebase Console, abrir el proyecto `masayfantasias`.
2. Crear una cuenta de servicio para el backend (IAM / Cuentas de servicio).
3. Guardar su JSON de clave de forma segura y copiar el JSON completo a la variable `FIREBASE_SERVICE_ACCOUNT_JSON` de Render.
4. No enviar el JSON por chat ni subirlo a GitHub.

El backend usa Admin SDK para crear los documentos de pedidos verificados y mantener los intentos pendientes en `pagos_pendientes`. Los clientes no deben tener permisos de escritura sobre esa colección.

## Configuración de Webhooks en Mercado Pago

Configurar notificaciones de tipo **Pagos** hacia:

`https://masayfan-backend.onrender.com/api/webhook`

Copiar la clave de firma secreta generada por Mercado Pago a `MP_WEBHOOK_SECRET` en Render. La ruta valida `x-signature` y consulta el pago directamente a Mercado Pago antes de registrar el pedido.

## Flujo

1. El cliente inicia sesión; el frontend envía su Firebase ID token.
2. El backend valida la sesión, recalcula precios con los documentos de `productos`, `opcionales` y `banners`, y crea una preferencia.
3. Se guarda el intento en `pagos_pendientes` antes de devolver el enlace de pago.
4. Al regresar el cliente, el backend consulta el pago a Mercado Pago. El webhook hace el mismo control sin depender de que el cliente vuelva al sitio.
5. Solo un pago `approved`, en ARS y por el importe esperado crea `pedidos/{external_reference}`. El proceso es idempotente.

## Endpoints

- `GET /health`: estado de configuración (no expone secretos).
- `POST /api/crear-preferencia`: requiere `Authorization: Bearer <Firebase ID token>`.
- `POST /api/verificar-pago`: requiere token Firebase, `payment_id` y `external_reference`.
- `POST /api/webhook`: notificación firmada de Mercado Pago.

## Despliegue

Render ejecuta `npm start`. Después de configurar las variables de entorno, desplegar el servicio y comprobar `/health`. No activar el nuevo frontend antes de que Firebase Admin y Mercado Pago aparezcan configurados.

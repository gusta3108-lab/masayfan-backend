# Fondo de Asistencia para Repartidores — diseño técnico preliminar

## Objetivo
Registrar aportes que Masa y Fantasías decida realizar con recursos propios para constituir una reserva destinada a ayudas extraordinarias a prestadores de reparto.

## Reglas de diseño
- El importe ofrecido y aceptado por el repartidor es su retribución íntegra.
- El aporte al fondo es adicional y se financia exclusivamente con recursos de Masa y Fantasías.
- No se descuenta ni retiene parte de la retribución del repartidor.
- La configuración admite importe fijo o porcentaje de la retribución acordada, pero permanece desactivada y sin importes predeterminados hasta aprobación expresa y revisión legal/contable.
- El aporte se registra únicamente después de que la entrega figure como completada y verificada.
- Cada movimiento debe referenciar un pedido para permitir auditoría e idempotencia en la futura integración.
- Los registros del fondo y las solicitudes de asistencia deben estar restringidos al administrador autorizado.
- La aplicación llevará un libro de movimientos y un saldo calculado; no realizará transferencias bancarias automáticas ni afirmará que el saldo informático equivale a dinero efectivamente depositado.
- La cuenta bancaria separada, titularidad, tratamiento contable, disponibilidad y reglas de desembolso deben definirse con contador y abogado argentinos antes de activar el fondo.
- El fondo no es una póliza, no reemplaza seguros legalmente exigibles y no garantiza una indemnización. La asistencia queda sujeta a criterios publicados, verificación y fondos disponibles, sin limitar derechos imperativos.

## Configuración futura
- `enabled`: falso por defecto.
- `mode`: `fixed` o `percentage`.
- `fixedAmount`: importe ARS, inicialmente cero.
- `percentage`: porcentaje, inicialmente cero.
- La pantalla administrativa debe mostrar, antes de ofrecer cada entrega, retribución íntegra del repartidor, aporte adicional del negocio y costo total para Masa y Fantasías.

## Estado
Esta rama contiene únicamente la base de cálculo y pruebas unitarias. No modifica pedidos reales, no activa aportes, no realiza movimientos de dinero y no se despliega a producción.

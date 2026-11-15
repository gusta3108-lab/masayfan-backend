# Contabilidad y conciliación — diseño preliminar

## Panel de contabilidad
El panel debe mostrar tarjetas separadas:
- Ventas brutas del día y del mes (pedidos no marcados como prueba).
- Importes cobrados/confirmados del día y del mes, separados de ventas pendientes.
- Cantidad de pedidos y entregas finalizadas.
- Fondo de asistencia: aportes contabilizados, asistencias efectivamente pagadas y saldo contable.

Los importes de venta se calculan sobre `pedidos.total`; ese campo actualmente representa el total de productos del pedido. No debe presentarse como ingreso neto, ganancia ni efectivo disponible. Antes de mostrar beneficios se deben incorporar costos, comisiones, impuestos, devoluciones y cargos de envío según el flujo real.

## Fondo de asistencia
- Cada aporte debe originarse en una contribución adicional de Masa y Fantasías, no en una retención al prestador.
- El aporte se contabiliza una sola vez por pedido, al completarse y verificarse la entrega.
- Las asistencias solo reducen el saldo cuando están efectivamente aprobadas y pagadas.
- Debe existir un identificador único por movimiento, referencia del pedido, fecha, administrador y comprobante/nota.
- Los estados pendientes, rechazados o anulados no modifican el saldo.

## Cierre diario y conciliación bancaria
La aplicación debe permitir registrar un depósito/transferencia a la cuenta separada con fecha, importe, referencia y comprobante. La conciliación compara:
1. saldo contable inicial + aportes efectivamente depositados - asistencias pagadas;
2. saldo real informado por el banco.

No se debe tratar un aporte devengado en el libro como dinero ya depositado. La conciliación bancaria se mantiene pendiente hasta que el usuario registre/valide el movimiento real.

## Seguridad y activación
- Consultas y operaciones solo para administradores autenticados.
- Libro inmutable: corregir con asientos de reversión, no borrar movimientos.
- Sin transferencias automáticas ni débitos en cuentas.
- Fondo y porcentajes desactivados hasta revisión legal y contable.
- La pantalla no debe mostrar ganancias netas sin costos y obligaciones completos.

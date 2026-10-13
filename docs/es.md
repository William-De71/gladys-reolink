# Reolink en Gladys

Esta integración lleva sus cámaras **Reolink** a Gladys: la imagen en el panel, el vídeo en directo, detecciones instantáneas como desencadenantes de escenas y, según el modelo, el control del foco, la sirena, los LED infrarrojos y los cabezales motorizados.

Todo ocurre **en su red local**. No se necesita ninguna cuenta Reolink y ninguna imagen pasa nunca por una nube.

## Lo que necesita

- Una o varias cámaras Reolink en la misma red que Gladys — independientes, o emparejadas con un **Home Hub** o un **NVR**.
- El usuario y la contraseña con los que accede a esas cámaras (los de la aplicación Reolink, normalmente `admin`).
- Gladys 5.0.0 o posterior.

Eso es todo. No hay que crear ninguna cuenta ni solicitar ninguna clave de API.

> **Cámaras con batería** (Argus, Go…): normalmente se accede a ellas a través de su Home Hub o su NVR — por sí solas, la mayoría no ofrecen la API local que usa esta integración.

## Puesta en marcha

1. En Gladys, abra **Integraciones → Instalar una integración** e instale Reolink.
2. En la pantalla de configuración, introduzca el **usuario** y la **contraseña** de sus cámaras.
3. Pulse **Probar la conexión**: Gladys busca sus cámaras e indica lo que sabe hacer cada una, si notifica sus detecciones al instante y si su vídeo en directo está disponible.
4. Vaya a **Descubrir** y lance una búsqueda: sus cámaras aparecen ahí, listas para añadirse. Detrás de un Home Hub o un NVR, cada cámara se convierte en un dispositivo propio.

### Ajustes recomendados en las cámaras

Los firmwares recientes de Reolink se entregan con algunos servicios de red **desactivados**. En la aplicación Reolink, abra **Ajustes → Red → Avanzado → Ajustes del servidor** (el nombre varía ligeramente según la versión de la aplicación) y active:

- **RTSP** — necesario para el vídeo en directo;
- **ONVIF** — necesario para las detecciones instantáneas (ver más abajo).

La prueba de conexión le indica, cámara por cámara, cuándo RTSP está desactivado.

### Si no se encuentra una cámara

Gladys busca sus cámaras mediante un broadcast de red. Algunos routers lo filtran, y una cámara en otra VLAN nunca lo recibe. En ese caso, introduzca su dirección en **Direcciones de las cámaras**, en la sección Avanzado:

```
192.168.1.42, 192.168.1.43
```

Si una cámara no usa el puerto estándar, añádalo: `192.168.1.42:8000`.

### Si sus cámaras no comparten la misma contraseña

Indique las excepciones en **Cuentas por cámara**:

```
192.168.1.42|gladys|MiContraseña
```

Las cámaras que no estén en esa lista usan la cuenta global.

## Lo que obtiene

Cada cámara recibe **las funciones que realmente tiene**. La integración pregunta a la cámara en lugar de fiarse de su nombre de modelo: dos cámaras de la misma gama pueden ser distintas.

| Función                     | En qué cámaras                                      |
| --------------------------- | --------------------------------------------------- |
| Imagen                      | Todas                                               |
| Vídeo en directo            | Todas (RTSP activado)                               |
| Movimiento                  | Todas                                               |
| Persona / Vehículo / Animal | Modelos con detección por IA                        |
| Timbre                      | Videotimbres                                        |
| Batería                     | Modelos con batería y solares                       |
| Cargando                    | Modelos con batería y solares                       |
| Foco                        | Modelos con foco blanco                             |
| Sirena                      | Modelos con altavoz de alarma                       |
| Infrarrojos                 | La mayoría de los modelos                           |
| Mover (flechas)             | Cámaras motorizadas (giro/inclinación, o solo zoom) |
| Posición                    | Cámaras motorizadas con posiciones guardadas        |

### Detecciones

Una cámara puede informar de lo que ve de dos maneras, y la integración elige sola la mejor para cada cámara:

- **Al instante, mediante ONVIF** — las cámaras con cable a las que se accede directamente **envían** sus eventos de movimiento, persona, vehículo, animal y timbre en el momento en que se producen, e indican también cuándo terminan. Es el funcionamiento por defecto, siempre que ONVIF esté activado en la cámara.
- **Mediante comprobaciones periódicas** — las cámaras con batería, las que están detrás de un Home Hub o un NVR y las que tienen ONVIF desactivado se consultan periódicamente. El intervalo de comprobación (15 segundos por defecto) es entonces el retraso de detección.

Si una cámara deja de responder por ONVIF, vuelve sola a las comprobaciones periódicas, y regresa a ONVIF en cuanto vuelve a responder. Puede desactivar ONVIF por completo con la opción **Detecciones instantáneas (ONVIF)** de la sección Avanzado.

Una detección también provoca una captura de imagen, para que el widget muestre lo ocurrido sin esperar.

Las detecciones de persona, vehículo y animal aparecen como detectores de movimiento llamados «Person», «Vehicle» y «Animal»: úselos en un desencadenante de escena como cualquier detector de movimiento, por ejemplo «cuando se detecte una persona en la verja, encender la luz de la entrada».

### Timbre

El botón del timbre aparece como una función **Timbre**: el panel muestra «Sonando» durante una llamada y después la hora de la última, y el editor de escenas ofrece **«Si suena el timbre»**.

### Cámaras motorizadas (PTZ)

- **Mover** muestra flechas en el panel. Cada pulsación mueve la cámara un pequeño paso, que se detiene solo — una escena que envía un movimiento nunca deja la cámara girando. Una cámara que solo tiene zoom recibe únicamente los botones de zoom.
- **Posición** lista, por su nombre, las posiciones guardadas en la aplicación Reolink. Elija una para enviar la cámara allí, desde el panel o desde una escena.

La lista de posiciones se lee al descubrir la cámara: tras guardar una nueva posición en la aplicación Reolink, vuelva a lanzar una búsqueda. La acción **Listar las posiciones PTZ** muestra lo que cada cámara tiene guardado en este momento.

### Cargando

Las cámaras con batería y solares reciben también una función **Cargando**: está activa mientras la cámara se recarga, en su cargador o gracias a su panel solar, e inactiva cuando la batería está llena o desenchufada. Úsela en una escena — «cuando la cámara del jardín deje de cargarse, avísame» — o simplemente para comprobar que un panel solar sigue haciendo su trabajo.

## Protección de la batería

Capturar una imagen es lo que más agota una cámara con batería o solar. Por eso la integración reduce el ritmo antes de que la batería llegue a un nivel crítico:

- **por debajo del 60 %**: la actualización automática se detiene. Abrir el widget o una detección siguen capturando una imagen;
- **por debajo del 40 %**: no se captura ninguna imagen;
- **vuelta a la normalidad** en cuanto la cámara vuelve a su cargador, o cuando alcanza el **80 %** con energía solar.

Ese 80 % está deliberadamente muy por encima del umbral de pausa: reanudar justo por encima reiniciaría la descarga de inmediato. Evite ponerlo al 100 % — una cámara solar se carga a tirones y rara vez marca exactamente lleno, lo que la dejaría en pausa indefinidamente, sin cargador en el que ponerla.

El nivel de batería y las detecciones se siguen leyendo en todos los casos: no cuesta casi nada, y es lo que permite saber cuándo se ha recargado la cámara.

Una cámara con batería que **deja de responder** — sueño profundo, sesión rechazada, red caída — también pasa a «solo bajo demanda»: su último nivel conocido ya no es fiable, y una cámara silenciosa tiene más probabilidades de estar vacía que llena.

Detrás de un Home Hub, el hub indica además qué cámaras están **dormidas**: la actualización automática nunca despierta a una cámara dormida, sea cual sea su nivel.

### Un intervalo de captura propio

Las cámaras con batería tienen su **propio intervalo de actualización**, independiente del de las cámaras con cable. Espaciar las capturas de un modelo solar no le cuesta nada a la frescura de sus cámaras conectadas a la red eléctrica.

| Ajuste                                            | Por defecto    | Se aplica a                   |
| ------------------------------------------------- | -------------- | ----------------------------- |
| Intervalo de actualización de imágenes            | 60 s           | solo cámaras con cable        |
| Intervalo de actualización de cámaras con batería | 900 s (15 min) | modelos con batería o solares |

Es el ajuste más eficaz de todos: lo que gasta batería es **despertar la cámara**, mucho más que la propia imagen. En invierno, o si su panel recibe poco sol, alargue ese intervalo y suba el umbral de pausa.

Todos los umbrales son configurables, y las cámaras con cable nunca se ven afectadas.

## Preguntas frecuentes

**La imagen del panel está congelada.**
Compruebe el intervalo de actualización en la sección Avanzado. Si la cámara funciona con batería, quizá esté en pausa: mire su nivel de batería.

**El vídeo en directo no arranca.**
El directo pasa por el flujo RTSP de la cámara. Ejecute **Probar la conexión**: indica cuándo RTSP está desactivado en una cámara. Actívelo en la aplicación Reolink (Ajustes → Red → Avanzado → Ajustes del servidor) y vuelva a lanzar una búsqueda.

**Mis detecciones llegan con retraso.**
La cámara se consulta periódicamente en lugar de enviar sus eventos. Ejecute **Probar la conexión**: una cámara marcada con «detecciones comprobadas periódicamente» funciona con batería, está detrás de un Home Hub o un NVR, o tiene ONVIF desactivado. En este último caso, active ONVIF en la aplicación Reolink y vuelva a lanzar una búsqueda.

**Se encuentra una cámara pero Gladys indica que las credenciales son rechazadas.**
La cuenta utilizada debe poder leer los ajustes de la cámara. Un usuario restringido funciona, pero una cuenta de «invitado» no siempre tiene los permisos necesarios.

**Mi foco se apaga solo.**
La cámara aplica su propia programación de iluminación. Cuando enciende el foco desde Gladys, la integración amplía esa programación a todo el día, y restablece sus propios ajustes cuando lo apaga desde Gladys. Un cambio hecho mientras tanto en la aplicación Reolink tiene prioridad.

**Falta una posición en la lista.**
Las posiciones se leen al descubrir la cámara. Vuelva a lanzar una búsqueda después de guardar una nueva posición en la aplicación Reolink.

**Una cámara de mi Home Hub no aparece.**
El hub solo lista las cámaras que puede alcanzar en ese momento. Compruebe que la cámara está alimentada y al alcance del hub, y vuelva a lanzar una búsqueda.

**Una cámara con batería añadida antes de la versión 1.4.0 no tiene la función Cargando.**
La función es nueva: abra **Descubrir**, lance una búsqueda y **actualice** la cámara. La función se añade; las existentes, su historial y sus escenas se conservan.

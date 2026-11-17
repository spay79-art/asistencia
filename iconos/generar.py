"""Genera los íconos PNG de la app de asistencia (sin dependencias: solo zlib y struct).

Diseño: fondo azul de la marca, una cruz blanca y una marca de verificación verde ("presente").
Uso:  python movil/iconos/generar.py
"""
import os
import struct
import zlib

AZUL = (31, 58, 95)
BLANCO = (255, 255, 255)
VERDE = (76, 194, 127)


def png(ruta, ancho, pixeles):
    filas = b''.join(b'\x00' + bytes(sum((list(p) for p in pixeles[y * ancho:(y + 1) * ancho]), [])) for y in range(ancho))

    def bloque(tipo, datos):
        return struct.pack('>I', len(datos)) + tipo + datos + struct.pack('>I', zlib.crc32(tipo + datos) & 0xffffffff)

    with open(ruta, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n')
        f.write(bloque(b'IHDR', struct.pack('>IIBBBBB', ancho, ancho, 8, 2, 0, 0, 0)))
        f.write(bloque(b'IDAT', zlib.compress(filas, 9)))
        f.write(bloque(b'IEND', b''))


def dentro_redondeado(x, y, n, radio):
    # Esquinas redondeadas (para el ícono normal; el "maskable" es cuadrado completo).
    cx = min(max(x, radio), n - 1 - radio)
    cy = min(max(y, radio), n - 1 - radio)
    return (x - cx) ** 2 + (y - cy) ** 2 <= radio ** 2


def distancia_segmento(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / float(dx * dx + dy * dy)))
    qx, qy = ax + t * dx, ay + t * dy
    return ((px - qx) ** 2 + (py - qy) ** 2) ** 0.5


def icono(n, maskable):
    # En el maskable, el dibujo va más chico (zona segura del 80 %).
    escala = 0.78 if maskable else 1.0
    centro = n / 2.0
    s = lambda v: centro + (v - 0.5) * n * escala
    pixeles = []
    for y in range(n):
        for x in range(n):
            if not maskable and not dentro_redondeado(x, y, n, int(n * 0.2)):
                pixeles.append(AZUL)  # Android/iOS recortan igual; se rellena con el fondo
                continue
            color = AZUL
            # Cruz: palo vertical y travesaño.
            if s(0.37) <= x <= s(0.49) and s(0.14) <= y <= s(0.80):
                color = BLANCO
            if s(0.23) <= x <= s(0.63) and s(0.30) <= y <= s(0.41):
                color = BLANCO
            # Marca de verificación abajo a la derecha.
            grosor = n * escala * 0.045
            if (distancia_segmento(x, y, s(0.60), s(0.70), s(0.69), s(0.79)) <= grosor or
                    distancia_segmento(x, y, s(0.69), s(0.79), s(0.86), s(0.58)) <= grosor):
                color = VERDE
            pixeles.append(color)
    return pixeles


if __name__ == '__main__':
    carpeta = os.path.dirname(os.path.abspath(__file__))
    for nombre, tam, mascara in [('icono-180.png', 180, False), ('icono-192.png', 192, False),
                                 ('icono-512.png', 512, False), ('icono-mascara-512.png', 512, True)]:
        png(os.path.join(carpeta, nombre), tam, icono(tam, mascara))
        print('Generado', nombre)

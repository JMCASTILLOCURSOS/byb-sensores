// ============================================================
//  BYB-NORTE — RECEPTOR v2 (ESP32-C3 Super Mini + NRF24L01+PA+LNA)
//  Recibe por NRF24 del TX y reenvia el MISMO JSON por:
//    - USB / Serial   (PC, Web Serial)
//    - Bluetooth BLE  (celular/tablet/PC, Web Bluetooth)
//  El dashboard usa la hora del equipo (no se envia "t").
// ============================================================
// LIBRERIAS: RF24 (TMRh20).  BLE viene incluido en el core ESP32.
// (Ya NO se usa ArduinoJson: el JSON se arma a mano y queda mas corto,
//  ~55 caracteres, ideal para BLE.)
//
// CONEXIONES ESP32-C3 Super Mini (igual que antes):
//   VCC->3V3 (NO 5V) | GND->GND | CE->GPIO3 | CSN->GPIO10
//   SCK->GPIO6 | MOSI->GPIO7 | MISO->GPIO5 | IRQ->NC
//   Capacitor 10-100uF entre VCC/GND del NRF24.
//
// IDE (Arduino):
//   Placa: ESP32C3 Dev Module
//   Tools > USB CDC On Boot > Enabled
//   Si al compilar dice "sketch too big": Tools > Partition Scheme >
//   "Huge APP (3MB No OTA)".
//
// BLE: nombre "BYB-NORTE-RX", servicio Nordic UART (NUS).
//   El dashboard se conecta con el boton CONECTAR > Bluetooth.
//   Nota: el ESP32-C3 solo tiene BLE (no Bluetooth clasico/SPP).
//
// CAMBIOS v2:
//   - Salida dual USB + BLE (mismo formato JSON por linea).
//   - Serial.setTxTimeoutMs(0): sin PC conectado no se bloquea el loop.
//   - Numeros con 1 decimal (antes salian como 54.70000076).
// ============================================================


// ESP32-C3 Super Mini: no tiene chip USB-serie; el Serial sale por USB nativo.
// Con "USB CDC On Boot" desactivado, Serial usa GPIO20/21 (UART0).
#if !ARDUINO_USB_CDC_ON_BOOT
#warning "Activa Herramientas > USB CDC On Boot > Enabled (placa ESP32C3 Dev Module)"
#endif

#include <SPI.h>
#include <RF24.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

// ── NRF24 ────────────────────────────────────────────────────
#define NRF_CE   3
#define NRF_CSN  10
#define NRF_SCK  6
#define NRF_MOSI 7
#define NRF_MISO 5

RF24 radio(NRF_CE, NRF_CSN);
const byte DIRECCION_RADIO[6] = "BYB01";

struct PaqueteDatos {
  float s1;
  float s2;
  float s3;
  float s4;
  float rpm;
};
PaqueteDatos paquete;

unsigned long ultimoPaquete = 0;
const unsigned long TIMEOUT_SIN_SENAL = 5000;
bool sinSenal = true;  // parte sin senal hasta recibir el primero

// ── BLE (Nordic UART Service, solo notificaciones TX->app) ───
#define BLE_NOMBRE   "BYB-NORTE-RX"
#define BLE_SERVICIO "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define BLE_CHAR_TX  "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"
#define BLE_CHUNK    20   // bytes por notificacion (seguro con MTU por defecto)

BLECharacteristic *bleTx = nullptr;
volatile bool bleConectado = false;

class CallbacksServidor : public BLEServerCallbacks {
  void onConnect(BLEServer *s) override { bleConectado = true; }
  void onDisconnect(BLEServer *s) override {
    bleConectado = false;
    BLEDevice::startAdvertising();   // vuelve a quedar visible
  }
};

void iniciarBLE() {
  BLEDevice::init(BLE_NOMBRE);
  BLEServer *servidor = BLEDevice::createServer();
  servidor->setCallbacks(new CallbacksServidor());

  BLEService *servicio = servidor->createService(BLE_SERVICIO);
  bleTx = servicio->createCharacteristic(BLE_CHAR_TX, BLECharacteristic::PROPERTY_NOTIFY);
  bleTx->addDescriptor(new BLE2902());
  servicio->start();

  BLEAdvertising *adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(BLE_SERVICIO);
  adv->setScanResponse(true);
  BLEDevice::startAdvertising();
}

// Envia una linea (termina en \n) por USB y por BLE.
void emitirLinea(const char *linea) {
  Serial.println(linea);

  if (bleConectado && bleTx != nullptr) {
    char buf[112];
    int n = snprintf(buf, sizeof(buf), "%s\n", linea);
    if (n < 0) return;
    if (n >= (int)sizeof(buf)) n = sizeof(buf) - 1;
    for (int off = 0; off < n; off += BLE_CHUNK) {
      int len = (n - off < BLE_CHUNK) ? (n - off) : BLE_CHUNK;
      bleTx->setValue((uint8_t *)(buf + off), len);
      bleTx->notify();
      delay(8);   // evita saturar la cola de notificaciones
    }
  }
}

void emitirStatus(const char *msg) {
  char buf[96];
  snprintf(buf, sizeof(buf), "{\"status\":\"%s\"}", msg);
  emitirLinea(buf);
}

void setup() {
  Serial.begin(115200);
  Serial.setTxTimeoutMs(0);   // no bloquear sin PC (si tu core no lo reconoce, borra esta linea)
  delay(300);

  SPI.begin(NRF_SCK, NRF_MISO, NRF_MOSI, NRF_CSN);

  if (!radio.begin(&SPI)) {
    emitirStatus("ERROR RADIO NO DETECTADO");
    while (1) delay(100);  // no seguir sin radio
  }
  if (!radio.isChipConnected()) {
    emitirStatus("ERROR NRF24 NO CONECTADO");
    while (1) delay(100);
  }
  radio.setPALevel(RF24_PA_LOW);
  radio.setDataRate(RF24_250KBPS);
  radio.setChannel(90);
  radio.openReadingPipe(1, DIRECCION_RADIO);
  radio.startListening();

  iniciarBLE();

  emitirStatus("RECEPTOR NRF24 LISTO");
}

void loop() {
  if (radio.available()) {
    radio.read(&paquete, sizeof(paquete));
    ultimoPaquete = millis();
    if (sinSenal) {
      sinSenal = false;
      emitirStatus("SENAL RECUPERADA");
    }

    // {"s1":54.7,"s2":null,"s3":32.5,"s4":57.4,"rpm":1442.0}
    char json[112];
    int p = 0;
    json[p++] = '{';
    float v[4] = { paquete.s1, paquete.s2, paquete.s3, paquete.s4 };
    const char *k[4] = { "s1", "s2", "s3", "s4" };
    for (int i = 0; i < 4; i++) {
      if (v[i] > -900.0) p += snprintf(json + p, sizeof(json) - p, "\"%s\":%.1f,", k[i], v[i]);
      else               p += snprintf(json + p, sizeof(json) - p, "\"%s\":null,", k[i]);
    }
    p += snprintf(json + p, sizeof(json) - p, "\"rpm\":%.1f}", paquete.rpm);
    emitirLinea(json);
  }

  if (!sinSenal && millis() - ultimoPaquete > TIMEOUT_SIN_SENAL) {
    emitirStatus("SIN SENAL DEL TRANSMISOR");
    sinSenal = true;
  }

  delay(10);
}

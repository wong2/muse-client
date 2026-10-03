import AppKit
import CoreBluetooth

// BLE transport only. JSON over stdin/stdout connects to the TypeScript SDK.
final class PairingHelper: NSObject, NSApplicationDelegate, CBPeripheralManagerDelegate {
    let serviceID = CBUUID(string: "7fdd3d1c-38ea-46cf-8b46-314ecf5f240c")
    let rxID = CBUUID(string: "4d593029-28a2-4a6e-a1f0-3c2d5e8f9b01")
    let txID = CBUUID(string: "d75dc4ca-7b2b-4e9c-8f0a-1d2e3f4a5b6c")
    var manager: CBPeripheralManager?
    var tx: CBMutableCharacteristic?
    var central: CBCentral?
    var pending: [Data] = []
    var lastValue = Data()
    var name = ""
    var sending = false
    var stopping = false
    var completed = false
    var completionScheduled = false
    var statusItem: NSStatusItem!

    func emit(_ value: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
        try? FileHandle.standardOutput.write(contentsOf: data + Data([10]))
    }
    func fail(_ message: String) { emit(["event": "error", "message": message]); quit() }

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "Muse Pair"
        let menu = NSMenu()
        menu.addItem(withTitle: "Quit Muse Pair", action: #selector(quit), keyEquivalent: "q").target = self
        statusItem.menu = menu
        DispatchQueue.global().async {
            var buffer = Data()
            while true {
                let chunk = FileHandle.standardInput.availableData
                if chunk.isEmpty { DispatchQueue.main.async { self.quit() }; return }
                buffer.append(chunk)
                if buffer.count > 262144 {
                    DispatchQueue.main.async { self.fail("IPC input exceeded size limit") }; return
                }
                while let newline = buffer.firstIndex(of: 10) {
                    let line = Data(buffer[..<newline]); buffer.removeSubrange(...newline)
                    guard let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else {
                        DispatchQueue.main.async { self.fail("Invalid IPC message") }; return
                    }
                    DispatchQueue.main.async { self.handle(object) }
                }
            }
        }
        // Also bound the native process lifetime if its parent stops responding.
        DispatchQueue.main.asyncAfter(deadline: .now() + 660) { self.fail("Pairing helper timed out") }
        emit(["event": "ready"])
    }

    func handle(_ event: [String: Any]) {
        guard !stopping else { return }
        switch event["event"] as? String {
        case "start":
            guard manager == nil, let requestedName = event["name"] as? String,
                  requestedName.range(of: "^MuseGadget[0-9A-F]{6}$", options: .regularExpression) != nil else {
                fail("Invalid device name or duplicate start"); return
            }
            name = requestedName
            manager = CBPeripheralManager(delegate: self, queue: .main)
        case "packets":
            guard let encoded = event["packets"] as? [String] else { fail("Invalid notification list"); return }
            for item in encoded {
                guard let packet = Data(base64Encoded: item), packet.count <= 20 else { fail("Invalid notification packet"); return }
                pending.append(packet)
            }
            if pending.count > 2048 { fail("Notification queue exceeded size limit"); return }
            flush()
        case "complete": completed = true; flush(); finishIfDrained()
        case "stop": quit()
        default: fail("Unknown IPC command")
        }
    }

    func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        emit(["event": "bluetooth", "state": peripheral.state.rawValue, "authorization": CBManager.authorization.rawValue])
        guard peripheral.state == .poweredOn else {
            if peripheral.state == .unauthorized { fail("Bluetooth permission denied. Allow Muse Pair in System Settings > Privacy & Security > Bluetooth.") }
            else if peripheral.state == .unsupported { fail("Bluetooth peripheral mode is unsupported") }
            else if central != nil { fail("Bluetooth became unavailable during pairing") }
            return
        }
        peripheral.removeAllServices()
        let service = CBMutableService(type: serviceID, primary: true)
        let rx = CBMutableCharacteristic(type: rxID, properties: [.write, .writeWithoutResponse], value: nil, permissions: [.writeable])
        let notify = CBMutableCharacteristic(type: txID, properties: [.read, .notify], value: nil, permissions: [.readable])
        tx = notify; service.characteristics = [rx, notify]
        peripheral.add(service)
    }
    func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
        if let error { fail("GATT registration failed: \(error.localizedDescription)"); return }
        // Name-only advertising was verified with Muse iOS. The GATT service
        // remains published; adding its UUID to advertising can hide the name.
        peripheral.startAdvertising([CBAdvertisementDataLocalNameKey: name])
    }
    func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
        if let error { fail("Advertising failed: \(error.localizedDescription)"); return }
        emit(["event": "advertising", "name": name])
    }
    func peripheralManager(_ peripheral: CBPeripheralManager, central peer: CBCentral, didSubscribeTo characteristic: CBCharacteristic) {
        guard central == nil || central?.identifier == peer.identifier else { return }
        central = peer; emit(["event": "subscribed"]); flush()
    }
    func peripheralManager(_ peripheral: CBPeripheralManager, central peer: CBCentral, didUnsubscribeFrom characteristic: CBCharacteristic) {
        guard central?.identifier == peer.identifier else { return }
        if !completed { emit(["event": "disconnected"]) }
        quit()
    }
    func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
        guard let first = requests.first else { return }
        guard !completed, requests.allSatisfy({ $0.characteristic.uuid == rxID && $0.offset == 0 && $0.value != nil &&
            $0.central.identifier == first.central.identifier && (central == nil || central?.identifier == $0.central.identifier) }) else {
            peripheral.respond(to: first, withResult: .writeNotPermitted); return
        }
        central = first.central
        for request in requests { emit(["event": "write", "data": request.value!.base64EncodedString()]) }
        peripheral.respond(to: first, withResult: .success)
    }
    func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveRead request: CBATTRequest) {
        guard request.characteristic.uuid == txID, central == nil || central?.identifier == request.central.identifier else {
            peripheral.respond(to: request, withResult: .readNotPermitted); return
        }
        guard request.offset <= lastValue.count else { peripheral.respond(to: request, withResult: .invalidOffset); return }
        request.value = lastValue.subdata(in: request.offset..<lastValue.count)
        peripheral.respond(to: request, withResult: .success)
    }
    func flush() {
        guard !stopping, !sending, !pending.isEmpty, let central, let tx, let manager,
              tx.subscribedCentrals?.contains(where: { $0.identifier == central.identifier }) == true else { finishIfDrained(); return }
        if manager.updateValue(pending[0], for: tx, onSubscribedCentrals: [central]) {
            lastValue = pending.removeFirst(); sending = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { self.sending = false; self.flush() }
        }
    }
    func finishIfDrained() {
        if completed && pending.isEmpty && !sending && !completionScheduled {
            completionScheduled = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.quit() }
        }
    }
    func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) { flush() }
    @objc func quit() {
        guard !stopping else { return }
        stopping = true; manager?.stopAdvertising(); manager?.removeAllServices()
        emit(["event": "stopped", "completed": completed])
        NSApplication.shared.terminate(nil)
    }
    func applicationWillTerminate(_ notification: Notification) { manager?.stopAdvertising() }
}

let app = NSApplication.shared
let delegate = PairingHelper()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()

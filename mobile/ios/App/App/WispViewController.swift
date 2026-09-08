import Capacitor

class WispViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(WispSecureSessionPlugin())
    }
}

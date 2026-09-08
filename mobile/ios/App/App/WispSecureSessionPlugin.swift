import Capacitor
import Foundation
import Security

@objc(WispSecureSessionPlugin)
public class WispSecureSessionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "WispSecureSessionPlugin"
    public let jsName = "WispSecureSession"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "write", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clear", returnType: CAPPluginReturnPromise)
    ]
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "com.gustavomiranda.wispbot.remote-session.v1",
         kSecAttrAccount as String: "remote-session",
         kSecAttrSynchronizable as String: false]
    }
    @objc func read(_ call: CAPPluginCall) {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { call.resolve(["value": NSNull()]); return }
        guard status == errSecSuccess, let data = result as? Data,
              let value = String(data: data, encoding: .utf8) else {
            call.reject("The protected session could not be read. Unlock this device and try again."); return
        }
        call.resolve(["value": value])
    }
    @objc func write(_ call: CAPPluginCall) {
        guard let value = call.getString("value"), let data = value.data(using: .utf8), data.count <= 16384 else {
            call.reject("Invalid protected session."); return
        }
        let attributes: [String: Any] = [kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var item = query
            for (key, value) in attributes { item[key] = value }
            status = SecItemAdd(item as CFDictionary, nil)
        }
        guard status == errSecSuccess else { call.reject("The session could not be saved in the device Keychain."); return }
        call.resolve()
    }
    @objc func clear(_ call: CAPPluginCall) {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { call.reject("The protected session could not be cleared."); return }
        call.resolve()
    }
}

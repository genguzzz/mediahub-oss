import Darwin
import Foundation

// DLNA renderer discovery for casting. iOS only allows multicast with a restricted entitlement, so
// besides the multicast M-SEARCH this also sends the same request unicast to every address of the
// Wi-Fi subnet; DMRs answer both. Blocking: call from a background task.
enum Ssdp {
  private static func wifiSubnet() -> (ip: UInt32, mask: UInt32)? {
    var head: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&head) == 0, let first = head else { return nil }
    defer { freeifaddrs(head) }
    var cur: UnsafeMutablePointer<ifaddrs>? = first
    while let ifa = cur {
      cur = ifa.pointee.ifa_next
      guard let addr = ifa.pointee.ifa_addr, let mask = ifa.pointee.ifa_netmask,
            addr.pointee.sa_family == UInt8(AF_INET),
            String(cString: ifa.pointee.ifa_name) == "en0" else { continue }
      let ip = addr.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { UInt32(bigEndian: $0.pointee.sin_addr.s_addr) }
      let m = mask.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { UInt32(bigEndian: $0.pointee.sin_addr.s_addr) }
      return (ip, m)
    }
    return nil
  }

  static func scan(timeoutMs: Int) -> [[String: String]] {
    let fd = socket(AF_INET, SOCK_DGRAM, 0)
    guard fd >= 0 else { return [] }
    defer { close(fd) }
    var tv = timeval(tv_sec: 0, tv_usec: 150_000)
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))

    let request = "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n"
    let bytes = Array(request.utf8)
    func send(to host: UInt32) {
      var a = sockaddr_in()
      a.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
      a.sin_family = sa_family_t(AF_INET)
      a.sin_port = UInt16(1900).bigEndian
      a.sin_addr.s_addr = host.bigEndian
      withUnsafePointer(to: &a) { p in
        p.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
          _ = sendto(fd, bytes, bytes.count, 0, sa, socklen_t(MemoryLayout<sockaddr_in>.size))
        }
      }
    }

    send(to: 0xEFFF_FFFA)
    if let net = wifiSubnet() {
      let mask = net.mask < 0xFFFF_FE00 ? 0xFFFF_FE00 : net.mask   // never sweep more than a /23
      let base = net.ip & mask
      let hosts = ~mask
      if hosts > 1 {
        for n in 1..<hosts where (base | n) != net.ip { send(to: base | n) }
      }
    }

    var found: [String: String] = [:]
    var buf = [UInt8](repeating: 0, count: 4096)
    let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000)
    while Date() < deadline {
      var from = sockaddr_in()
      var len = socklen_t(MemoryLayout<sockaddr_in>.size)
      let n = withUnsafeMutablePointer(to: &from) { p in
        p.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in recvfrom(fd, &buf, buf.count, 0, sa, &len) }
      }
      guard n > 0, let text = String(bytes: buf[0..<n], encoding: .utf8) else { continue }
      for line in text.components(separatedBy: "\r\n") where line.lowercased().hasPrefix("location:") {
        let loc = line.dropFirst("location:".count).trimmingCharacters(in: .whitespaces)
        let ip = String(cString: inet_ntoa(from.sin_addr))
        if found[loc] == nil { found[loc] = ip }
      }
    }
    return found.map { ["location": $0.key, "ip": $0.value] }
  }
}

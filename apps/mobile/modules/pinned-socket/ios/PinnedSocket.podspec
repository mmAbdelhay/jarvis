Pod::Spec.new do |s|
  s.name           = 'PinnedSocket'
  s.version        = '1.0.0'
  s.summary        = 'A fingerprint-pinned WebSocket transport for the Jarvis phone client.'
  s.description    = <<-DESC
                        Wraps URLSessionWebSocketTask with a delegate that trusts exactly the
                        laptop's self-signed leaf certificate by its SHA-256 fingerprint,
                        never the system trust store.
                      DESC
  s.license        = 'UNLICENSED'
  s.author         = 'Jarvis'
  s.homepage       = 'https://github.com/jarvis'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { :git => '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.{h,m,mm,swift}'
end

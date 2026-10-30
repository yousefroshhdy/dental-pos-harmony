package eg.honest.os;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * Which messages from the web page may reach the Capacitor bridge (audit 4 F1). Pure Java,
 * so it is unit-tested on the JVM (src/test/.../BridgePolicyTest.java).
 *
 * A message is passed on only when ALL of these hold:
 * - it comes from the top frame (never an iframe, whatever its origin);
 * - its origin is exactly the configured server origin (capacitor.config.ts server.url);
 * - it is a Capacitor plugin call (no Cordova call, no other message type);
 * - the plugin is BackgroundGeolocation and the method is one the web app uses
 *   (src/lib/native/background-geolocation.ts). Capacitor's built-in plugins
 *   (CapacitorCookies, CapacitorHttp, WebView, SystemBars) are not reachable at all.
 *
 * Adding a native feature means adding its plugin and methods here, on purpose.
 */
final class BridgePolicy {

    static final String PLUGIN = "BackgroundGeolocation";
    // Not Set.of: that is Android API 30+, and minSdk is 24.
    static final Set<String> METHODS = Collections.unmodifiableSet(
        new HashSet<>(Arrays.asList("addWatcher", "removeWatcher", "openSettings"))
    );

    private BridgePolicy() {}

    /**
     * "https://host" (or "https://host:port" for a non-default port), lower-cased, for an https
     * URL that is a bare origin (no user info, path, query or fragment); otherwise null.
     */
    static String origin(String url) {
        if (url == null) {
            return null;
        }
        URI uri;
        try {
            uri = new URI(url.trim());
        } catch (URISyntaxException ex) {
            return null;
        }
        String host = uri.getHost();
        if (!"https".equalsIgnoreCase(uri.getScheme()) || host == null || host.isEmpty() || uri.getRawUserInfo() != null) {
            return null;
        }
        String path = uri.getRawPath();
        if ((path != null && !path.isEmpty() && !path.equals("/")) || uri.getRawQuery() != null || uri.getRawFragment() != null) {
            return null;
        }
        int port = uri.getPort();
        return "https://" + host.toLowerCase(Locale.ROOT) + (port == -1 || port == 443 ? "" : ":" + port);
    }

    /**
     * Null when the message may go to the bridge; otherwise the reason it is refused (for the log:
     * it never contains anything the page sent).
     *
     * @param isMainFrame   whether the message comes from the top frame
     * @param sourceOrigin  the sending frame's origin as the WebView reports it
     * @param allowedOrigin {@link #origin(String)} of the configured server URL
     * @param type          the message's "type" (null for a Capacitor plugin call)
     * @param pluginId      the message's "pluginId"
     * @param methodName    the message's "methodName"
     */
    static String refusal(
        boolean isMainFrame,
        String sourceOrigin,
        String allowedOrigin,
        String type,
        String pluginId,
        String methodName
    ) {
        if (!isMainFrame) {
            return "not the top frame";
        }
        String source = origin(sourceOrigin);
        if (allowedOrigin == null || source == null || !source.equals(allowedOrigin)) {
            return "origin not allowed";
        }
        if (type != null) {
            return "message type not allowed";
        }
        if (!PLUGIN.equals(pluginId)) {
            return "plugin not allowed";
        }
        if (methodName == null || !METHODS.contains(methodName)) {
            return "method not allowed";
        }
        return null;
    }
}

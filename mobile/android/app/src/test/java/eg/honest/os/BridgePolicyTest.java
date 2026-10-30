package eg.honest.os;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

/** Audit 4 F1: what may reach the Capacitor bridge. Runs on the JVM (./gradlew testDebugUnitTest). */
public class BridgePolicyTest {

    private static final String APP = "https://honest-os-staging.vercel.app";

    @Test
    public void originIsTheBareHttpsOrigin() {
        assertEquals(APP, BridgePolicy.origin(APP));
        assertEquals(APP, BridgePolicy.origin(APP + "/"));
        assertEquals(APP, BridgePolicy.origin("HTTPS://Honest-OS-Staging.Vercel.App"));
        assertEquals(APP, BridgePolicy.origin(APP + ":443"));
        assertEquals("https://example.test:8443", BridgePolicy.origin("https://example.test:8443"));
        assertNull(BridgePolicy.origin(null));
        assertNull(BridgePolicy.origin(""));
        assertNull(BridgePolicy.origin("http://honest-os-staging.vercel.app"));
        assertNull(BridgePolicy.origin("https://localhost/offline.html"));
        assertNull(BridgePolicy.origin(APP + "/ar"));
        assertNull(BridgePolicy.origin(APP + "?x=1"));
        assertNull(BridgePolicy.origin("https://user@honest-os-staging.vercel.app"));
        assertNull(BridgePolicy.origin("null"));
        assertNull(BridgePolicy.origin("not a url"));
    }

    @Test
    public void theWebAppsOwnCallsPass() {
        for (String method : new String[] { "addWatcher", "removeWatcher", "openSettings" }) {
            assertNull(BridgePolicy.refusal(true, APP, APP, null, "BackgroundGeolocation", method));
        }
    }

    @Test
    public void framesOtherThanTheTopFrameAreRefused() {
        assertEquals("not the top frame", BridgePolicy.refusal(false, APP, APP, null, "BackgroundGeolocation", "addWatcher"));
        assertEquals("not the top frame", BridgePolicy.refusal(false, "https://evil.example", APP, null, "BackgroundGeolocation", "removeWatcher"));
    }

    @Test
    public void otherOriginsAreRefused() {
        assertEquals("origin not allowed", BridgePolicy.refusal(true, "https://evil.example", APP, null, "BackgroundGeolocation", "addWatcher"));
        // The offline page (Capacitor's local origin) needs no plugin.
        assertEquals("origin not allowed", BridgePolicy.refusal(true, "https://localhost", APP, null, "BackgroundGeolocation", "addWatcher"));
        assertEquals("origin not allowed", BridgePolicy.refusal(true, "http://honest-os-staging.vercel.app", APP, null, "BackgroundGeolocation", "addWatcher"));
        assertEquals("origin not allowed", BridgePolicy.refusal(true, "https://honest-os-staging.vercel.app.evil.example", APP, null, "BackgroundGeolocation", "addWatcher"));
        assertEquals("origin not allowed", BridgePolicy.refusal(true, null, APP, null, "BackgroundGeolocation", "addWatcher"));
        assertEquals("origin not allowed", BridgePolicy.refusal(true, APP, null, null, "BackgroundGeolocation", "addWatcher"));
    }

    @Test
    public void builtInPluginsCordovaAndOtherMessagesAreRefused() {
        assertEquals("plugin not allowed", BridgePolicy.refusal(true, APP, APP, null, "CapacitorCookies", "setCookie"));
        assertEquals("plugin not allowed", BridgePolicy.refusal(true, APP, APP, null, "CapacitorCookies", "clearAllCookies"));
        assertEquals("plugin not allowed", BridgePolicy.refusal(true, APP, APP, null, "CapacitorHttp", "request"));
        assertEquals("plugin not allowed", BridgePolicy.refusal(true, APP, APP, null, "WebView", "setServerBasePath"));
        assertEquals("plugin not allowed", BridgePolicy.refusal(true, APP, APP, null, null, "addWatcher"));
        assertEquals("message type not allowed", BridgePolicy.refusal(true, APP, APP, "cordova", "BackgroundGeolocation", "addWatcher"));
        assertEquals("message type not allowed", BridgePolicy.refusal(true, APP, APP, "js.error", null, null));
        assertEquals("message type not allowed", BridgePolicy.refusal(true, APP, APP, "", "BackgroundGeolocation", "addWatcher"));
    }

    @Test
    public void otherMethodsOfThePluginAreRefused() {
        assertEquals("method not allowed", BridgePolicy.refusal(true, APP, APP, null, "BackgroundGeolocation", "addListener"));
        assertEquals("method not allowed", BridgePolicy.refusal(true, APP, APP, null, "BackgroundGeolocation", "requestPermissions"));
        assertEquals("method not allowed", BridgePolicy.refusal(true, APP, APP, null, "BackgroundGeolocation", null));
    }
}

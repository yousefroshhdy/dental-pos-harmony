package eg.honest.os;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;

/**
 * Honest OS shell: a WebView on the deployment in capacitor.config.ts (server.url).
 * The web app drives background location through the background-geolocation plugin,
 * and only while the rep has a working day open (D-14). Plugin calls are accepted only
 * from the top frame of that deployment, and only for that plugin (HonestWebView,
 * BridgePolicy).
 */
public class MainActivity extends BridgeActivity {

    private static final int NOTIFICATIONS_REQUEST = 4201;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Audit 4 F1: plugin calls must go through the guarded bridge (HonestWebView). If a
        // Capacitor update stopped using the app's layout override, Capacitor's legacy bridge
        // would be reachable from every frame again: refuse to run rather than run unguarded.
        if (bridge != null && !(bridge.getWebView() instanceof HonestWebView)) {
            throw new IllegalStateException(
                "Honest OS: the WebView is not HonestWebView; check res/layout/capacitor_bridge_layout_main.xml"
            );
        }
        // Android 13+: the permanent "recording your location" notification of the location
        // foreground service is shown only with this runtime permission, and the plugin does
        // not ask for it. Asked once at launch; the rep can change it in the app settings.
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            ActivityCompat.requestPermissions(this, new String[] { Manifest.permission.POST_NOTIFICATIONS }, NOTIFICATIONS_REQUEST);
        }
    }
}

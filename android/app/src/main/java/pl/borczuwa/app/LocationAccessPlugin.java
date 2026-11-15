package pl.borczuwa.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.webkit.GeolocationPermissions;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "LocationAccess")
public class LocationAccessPlugin extends Plugin {
    private static final String APP_ORIGIN = "https://localhost";
    @PluginMethod
    public void prepare(PluginCall call) {
        boolean bundled = getBridge().getServerUrl() == null && APP_ORIGIN.equals(getBridge().getLocalUrl());
        boolean granted = bundled && (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_FINE_LOCATION)
            == PackageManager.PERMISSION_GRANTED
            || ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_COARSE_LOCATION)
            == PackageManager.PERMISSION_GRANTED);
        getActivity().runOnUiThread(() -> {
            // Capacitor's geolocation callback does not retain its origin grant. Reuse only the
            // OS permission already given to this app, including Android's approximate location.
            GeolocationPermissions permissions = GeolocationPermissions.getInstance();
            if (granted) permissions.allow(APP_ORIGIN);
            else permissions.clear(APP_ORIGIN);
            JSObject result = new JSObject();
            result.put("granted", granted);
            call.resolve(result);
        });
    }
}

package pl.borczuwa.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "ReminderGuard")
public class ReminderGuardPlugin extends Plugin {
    @PluginMethod
    public void nonce(PluginCall call) {
        call.resolve(new JSObject().put("nonce", ReminderGuard.nonce(getContext())));
    }
}

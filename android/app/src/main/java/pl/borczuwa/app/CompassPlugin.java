package pl.borczuwa.app;

import android.content.Context;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.List;

// Rotation vector fuses the magnetometer, so it is north-referenced. The game rotation
// vector and the gyroscope alone are relative and are never used here.
@CapacitorPlugin(name = "Compass")
public class CompassPlugin extends Plugin implements SensorEventListener {
    private SensorManager manager;
    private boolean running;
    private int magneticAccuracy = SensorManager.SENSOR_STATUS_UNRELIABLE;
    private double fieldMicrotesla = -1;
    private final float[] matrix = new float[9];

    @PluginMethod
    public void start(PluginCall call) {
        manager = (SensorManager) getContext().getSystemService(Context.SENSOR_SERVICE);
        Sensor rotation = manager == null ? null : manager.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR);
        Sensor magnetic = manager == null ? null : manager.getDefaultSensor(Sensor.TYPE_MAGNETIC_FIELD);
        if (rotation == null || magnetic == null) {
            call.reject("compass_unavailable");
            return;
        }
        stopSensors();
        magneticAccuracy = SensorManager.SENSOR_STATUS_UNRELIABLE;
        fieldMicrotesla = -1;
        manager.registerListener(this, rotation, SensorManager.SENSOR_DELAY_UI);
        manager.registerListener(this, magnetic, SensorManager.SENSOR_DELAY_UI);
        running = true;
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopSensors();
        call.resolve();
    }

    @Override
    protected void handleOnPause() {
        stopSensors();
        super.handleOnPause();
    }

    @Override
    protected void handleOnDestroy() {
        stopSensors();
        super.handleOnDestroy();
    }

    private void stopSensors() {
        if (manager != null && running) manager.unregisterListener(this);
        running = false;
    }

    @Override
    public void onSensorChanged(SensorEvent event) {
        if (event.sensor.getType() == Sensor.TYPE_MAGNETIC_FIELD) {
            fieldMicrotesla = Math.sqrt(event.values[0] * event.values[0] + event.values[1] * event.values[1] +
                event.values[2] * event.values[2]);
            magneticAccuracy = event.accuracy;
            return;
        }
        if (event.sensor.getType() != Sensor.TYPE_ROTATION_VECTOR) return;
        SensorManager.getRotationMatrixFromVector(matrix, event.values);
        List<Double> values = new ArrayList<>();
        for (float value : matrix) values.add((double) value);
        JSObject reading = new JSObject();
        reading.put("matrix", new JSArray(values));
        reading.put("magneticAccuracy", magneticAccuracy);
        reading.put("fieldMicrotesla", fieldMicrotesla);
        reading.put("headingAccuracyDegrees", event.values.length > 4 && event.values[4] >= 0
            ? Math.toDegrees(event.values[4]) : -1);
        notifyListeners("reading", reading);
    }

    @Override
    public void onAccuracyChanged(Sensor sensor, int accuracy) {
        if (sensor.getType() == Sensor.TYPE_MAGNETIC_FIELD) magneticAccuracy = accuracy;
    }
}

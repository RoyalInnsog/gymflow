/**
 * Gym Flow - Background Geofencing Architecture
 * 
 * This script is designed to be loaded by the Member Android/iOS App built with Capacitor.
 * It interfaces with the `@transistorsoft/capacitor-background-geolocation` plugin (or similar)
 * to automatically trigger check-ins when the user enters the gym's geofence, 
 * even if the app is closed or running in the background.
 */

const BackgroundGeofenceService = {
  plugin: null,
  isInitialized: false,

  async init() {
    // Check if running natively inside Capacitor
    if (!window.Capacitor || !window.Capacitor.Plugins) {
      console.log('[BackgroundGeofence] Not running in a native Capacitor context. Standard HTML5 geolocation will be used for foreground only.');
      return;
    }

    // Try to load the TransistorSoft Background Geolocation plugin
    this.plugin = window.Capacitor.Plugins.BackgroundGeolocation;
    
    if (!this.plugin) {
      console.warn('[BackgroundGeofence] BackgroundGeolocation plugin not installed. Background check-ins will not function.');
      return;
    }

    try {
      // 1. Listen for Geofence transitions (ENTER/EXIT)
      this.plugin.onGeofence(this.onGeofenceTransition.bind(this));
      
      // 2. Configure the plugin for "Always On" tracking
      const state = await this.plugin.ready({
        desiredAccuracy: this.plugin.DESIRED_ACCURACY_HIGH,
        distanceFilter: 10,
        stopOnTerminate: false, // Keep running after app is swiped away
        startOnBoot: true,      // Restart on device reboot
        debug: false,           // Set to true to hear sounds on geofence entry
        logLevel: this.plugin.LOG_LEVEL_VERBOSE
      });

      // 3. Request "Always Allow" location permission
      // This will prompt the user if they haven't granted it yet.
      const permission = await this.plugin.requestPermission();
      if (permission !== this.plugin.AUTHORIZATION_STATUS_ALWAYS) {
        console.warn('[BackgroundGeofence] User did not grant "Always" location permission. Background tracking may be restricted by Android/iOS.');
      }

      if (!state.enabled) {
        await this.plugin.start();
      }

      this.isInitialized = true;
      console.log('[BackgroundGeofence] Service initialized successfully.');
      
    } catch (err) {
      console.error('[BackgroundGeofence] Failed to initialize:', err);
    }
  },

  /**
   * Called automatically by the plugin when the device enters/exits a registered geofence.
   */
  async onGeofenceTransition(event) {
    console.log(`[BackgroundGeofence] Geofence Transition: ${event.action} for ${event.identifier}`);
    
    if (event.action === 'ENTER' && event.identifier.startsWith('gym_')) {
      const tenantId = event.identifier.replace('gym_', '');
      
      try {
        // Automatically check-in via the API
        // We use the location coordinates provided by the geofence event itself.
        const res = await fetch('https://YOUR_API_DOMAIN/api/v1/attendance/checkin', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Note: Native fetch may need the JWT token attached manually here 
            // if cookies are not shared in the Capacitor background runner context.
            // 'Authorization': `Bearer ${localStorage.getItem('token')}`
          },
          body: JSON.stringify({
            latitude: event.location.coords.latitude,
            longitude: event.location.coords.longitude,
            timestamp: Date.now(),
            tenant_id: tenantId // Pass tenant ID if member belongs to multiple gyms
          })
        });

        if (res.ok) {
          console.log('[BackgroundGeofence] Auto-Checkin successful!');
          // Optionally trigger a local push notification saying "Checked into Gym Flow!"
        } else {
          console.error('[BackgroundGeofence] Auto-Checkin rejected:', await res.text());
        }
      } catch (err) {
        console.error('[BackgroundGeofence] Network error during auto-checkin:', err);
      }
    }
  },

  /**
   * Register a new Gym Geofence.
   * This should be called after the Member logs in and fetches their gym's details.
   */
  async registerGymGeofence(tenantId, latitude, longitude, radiusMeters) {
    if (!this.isInitialized || !this.plugin) return;

    try {
      await this.plugin.addGeofence({
        identifier: `gym_${tenantId}`,
        radius: radiusMeters || 50,
        latitude: parseFloat(latitude),
        longitude: parseFloat(longitude),
        notifyOnEntry: true,
        notifyOnExit: false, // We only care about check-ins right now
        notifyOnDwell: false
      });
      console.log(`[BackgroundGeofence] Registered geofence for Gym ${tenantId}`);
    } catch (err) {
      console.error('[BackgroundGeofence] Failed to add geofence:', err);
    }
  }
};

window.BackgroundGeofenceService = BackgroundGeofenceService;

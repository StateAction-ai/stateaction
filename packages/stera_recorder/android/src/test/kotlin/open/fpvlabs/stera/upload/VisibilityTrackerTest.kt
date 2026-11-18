package open.fpvlabs.stera.upload

import android.app.Activity
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner

/**
 * The tracker is registered when the plugin attaches, which can be after an activity already started
 * (cached engine, re-attach after a configuration change). `seed` must pick that activity up, and it
 * must stay fail-closed for one that is not started.
 */
@RunWith(RobolectricTestRunner::class)
@org.robolectric.annotation.Config(sdk = [35], manifest = org.robolectric.annotation.Config.NONE)
class VisibilityTrackerTest {
    private fun activity(): Activity = Robolectric.buildActivity(Activity::class.java).create().get()

    @Test fun anActivityStartedBeforeRegistrationIsVisibleAfterSeeding() {
        val a = activity()
        val tracker = VisibilityTracker(startedProbe = { true })
        assertFalse("callbacks never saw this activity start", tracker.visible)
        tracker.seed(a)
        assertTrue(tracker.visible)
        tracker.onActivityStopped(a)
        assertFalse(tracker.visible)
    }

    @Test fun seedingAnActivityThatIsNotStartedStaysNotVisible() {
        val tracker = VisibilityTracker(startedProbe = { false })
        tracker.seed(activity())
        assertFalse(tracker.visible)
    }

    @Test fun aNotYetVisibleWindowDuringOnStartDoesNotEraseWhatTheCallbacksSaw() {
        val a = activity()
        val tracker = VisibilityTracker(startedProbe = { false })
        tracker.onActivityStarted(a)
        tracker.seed(a) // re-attach while the window is not shown yet
        assertTrue(tracker.visible)
        tracker.onActivityDestroyed(a)
        assertFalse(tracker.visible)
    }

    @Test fun repeatedStartsAndSeedsAreCountedOncePerActivity() {
        val a = activity()
        val tracker = VisibilityTracker(startedProbe = { true })
        tracker.seed(a)
        tracker.onActivityStarted(a)
        tracker.seed(a)
        tracker.onActivityStopped(a)
        assertFalse("one stop ends visibility; no leaked counter", tracker.visible)
    }

    @Test fun theDefaultProbeUsesTheLiveWindowAndIsFalseForAnActivityWithoutOne() {
        // Created but never given a window: not started, so it must not seed as visible.
        val tracker = VisibilityTracker()
        tracker.seed(activity())
        assertFalse(tracker.visible)
    }
}

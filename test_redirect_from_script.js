/*
 * Test whether the rewrite-requests-from-script API implemented here:
 * https://bugzilla.mozilla.org/show_bug.cgi?id=765934 is functioning
 * correctly
 *
 * The test has the following components:
 *
 * testViaXHR() checks that internal redirects occur correctly for requests
 * made with nsIXMLHttpRequest objects.
 *
 * testViaAsyncOpen() checks that internal redirects occur correctly when made
 * with nsIHTTPChannel.asyncOpen().
 *
 * Both of the above functions tests three requests, a simple case that
 * redirects within a server; a second that redirects to a second webserver;
 * and a third where internal script redirects in response to a server-side
 * 302 redirect.  The successful redirects are confirmed by the presence of a
 * custom response header.
 *
 */

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;
const Cr = Components.results;

Cu.import("resource://testing-common/httpd.js");

var httpServer = null, httpServer2 = null;

// Test Part 1: a cross-path redirect on a single HTTP server
// http://localhost:4444/bait -> http://localhost:4444/switch
var baitPath = "/bait";
var baitURI = "http://localhost:4444" + baitPath;
var baitText = "you got the worm";

var redirectedPath = "/switch";
var redirectedURI = "http://localhost:4444" + redirectedPath;
var redirectedText = "worms are not tasty";

// Test Part 2: Now, a redirect to a different server
// http://localhost:4444/bait2 -> http://localhost:4445/switch
var bait2Path = "/bait2";
var bait2URI = "http://localhost:4444" + bait2Path;
var redirected2URI = "http://localhost:4445" + redirectedPath;

// Test Part 3, begin with a serverside redirect that itself turns into an instance
// of Test 1
var serverSideRedirectPath = "/frog";
var serverSideRedirectURI = "http://localhost:4444" + serverSideRedirectPath;

var testHeaderName = "X-Redirected-By-Script"
var testHeaderVal = "Yes indeed";
var testHeaderVal2 = "Very Yes";


function make_channel(url, callback, ctx) {
  var ios = Cc["@mozilla.org/network/io-service;1"].
            getService(Ci.nsIIOService);
  return ios.newChannel(url, "", null);
}

function baitHandler(metadata, response)
{
  // Content-Type required: https://bugzilla.mozilla.org/show_bug.cgi?id=748117
  response.setHeader("Content-Type", "text/html", false);
  response.bodyOutputStream.write(baitText, baitText.length);
  response.setHeader(testHeaderName, testHeaderVal);
}

function redirectedHandler(metadata, response)
{
  response.setHeader("Content-Type", "text/html", false);
  response.bodyOutputStream.write(redirectedText, redirectedText.length);
  response.setHeader(testHeaderName, testHeaderVal);
}

function redirected2Handler(metadata, response)
{
  response.setHeader("Content-Type", "text/html", false);
  response.bodyOutputStream.write(redirectedText, redirectedText.length);
  response.setHeader(testHeaderName, testHeaderVal2);
}

function serverSideRedirectHandler(metadata, response)
{
  response.setHeader("Content-Type", "text/html", false);  
  response.setStatusLine(metadata.httpVersion, 302, "Found");
  response.setHeader("Location", redirectedURI);
}

redirectOpportunity = "http-on-opening-request";
Redirector.prototype = {
  // This class observes the an event and uses that to
  // trigger a redirectTo(uri) redirect using the new API
  // before https://bugzilla.mozilla.org/show_bug.cgi?id=800799
  // the event was http-on-modify-request; now it's http-on-opening-request
  register: function()
  {
    var obsService = Cc["@mozilla.org/observer-service;1"].
                     getService(Ci.nsIObserverService);
		try {
			// Firefox ~18+
			obsService.addObserver(this, redirectOpportunity, true);
		} catch(e) {
			// Older platforms
			redirectOpportunity = "http-on-modify-request";
			obsService.addObserver(this, redirectOpportunity, true);
		}
  },

  QueryInterface: function(iid)
  {
    if (iid.equals(Ci.nsIObserver) ||
        iid.equals(Ci.nsISupportsWeakReference) ||
        iid.equals(Ci.nsISupports))
      return this;
    throw Components.results.NS_NOINTERFACE;
  },

  observe: function(subject, topic, data)
  {
    if (topic == redirectOpportunity) {
      if (!(subject instanceof Ci.nsIHttpChannel)) return;
      var channel = subject.QueryInterface(Ci.nsIHttpChannel);
      var ioservice = Cc["@mozilla.org/network/io-service;1"].
                        getService(Ci.nsIIOService);
      var target = null;
      if (channel.URI.spec == baitURI)  target = redirectedURI;
      if (channel.URI.spec == bait2URI) target = redirected2URI;
      // if we have a target, redirect there
      if (target) {
        var tURI = ioservice.newURI(target, null, null);
        try       { channel.redirectTo(tURI); }
        catch (e) { do_throw("Exception in redirectTo " + e + "\n"); }
      }
    }
  }
}

finished=false;

function Redirector()
{
  this.register();
}

function testViaAsyncOpen()
{
  // Test Part 1
  var chan = make_channel(baitURI);
  chan.asyncOpen(new ChannelListener(asyncVerifyCallback), null);
}

function testViaAsyncOpen2()
{
  // The first half of this test has been verified, now run the second half
  var chan = make_channel(bait2URI);
  chan.asyncOpen(new ChannelListener(asyncVerifyCallback2), null);
}

function testViaAsyncOpen3()
{
  // Now the third half
  var chan = make_channel(serverSideRedirectURI);
  chan.asyncOpen(new ChannelListener(asyncVerifyCallback3), null);
}

function makeVerifier(headerValue, nextTask)
{
  var verifier = function(req, buffer)
  {
    if (!(req instanceof Ci.nsIHttpChannel))
      do_throw(req + " is not an nsIHttpChannel, catastrophe imminent!");

    var httpChannel = req.QueryInterface(Ci.nsIHttpChannel);
    do_check_eq(httpChannel.getResponseHeader(testHeaderName), headerValue);
    do_check_eq(buffer, redirectedText);
    nextTask();
  };
  return verifier;
}

asyncVerifyCallback  = makeVerifier(testHeaderVal,  testViaAsyncOpen2);
asyncVerifyCallback2 = makeVerifier(testHeaderVal2, testViaAsyncOpen3);
asyncVerifyCallback3 = makeVerifier(testHeaderVal,  done);

function testViaXHR()
{
  var xhr = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"];

  var req = xhr.createInstance(Ci.nsIXMLHttpRequest);
  req.open("GET", baitURI, false);
  req.send();
  do_check_eq(req.getResponseHeader(testHeaderName), testHeaderVal);
  do_check_eq(req.response, redirectedText);

  req = xhr.createInstance(Ci.nsIXMLHttpRequest);
  req.open("GET", bait2URI, false);
  req.send();
  do_check_eq(req.getResponseHeader(testHeaderName), testHeaderVal2);
  do_check_eq(req.response, redirectedText);
}

function done()
{
  dump("done()");
  httpServer.stop(function () {httpServer2.stop(do_test_finished);});
}

function run_test()
{
  httpServer = new HttpServer();
  httpServer.registerPathHandler(baitPath, baitHandler);
  httpServer.registerPathHandler(bait2Path, baitHandler);
  httpServer.registerPathHandler(serverSideRedirectPath, 
                                 serverSideRedirectHandler);
  httpServer.registerPathHandler(redirectedPath, redirectedHandler);
  httpServer.start(4444);
  httpServer2 = new HttpServer();
  httpServer2.registerPathHandler(redirectedPath, redirected2Handler);
  httpServer2.start(4445);

  redirected = new Redirector();

  testViaXHR();
  testViaAsyncOpen();  // will call done() asynchronously for cleanup

  do_test_pending();
}

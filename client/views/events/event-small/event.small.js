Template.eventSmall.onCreated(function() {
	this.headerHeight = Template.currentData().withDate ? 75 : 55;
});

Template.eventSmall.events({
	"mouseover .js-location-link": function(event, template){
		template.$('.event-small').addClass('elevate_child');
	},
	"mouseout .js-location-link": function(event, template){
		template.$('.event-small').removeClass('elevate_child');
	}
});

Template.eventSmall.rendered = function() {
	this.$('.event-small-header').dotdotdot({
		height: this.headerHeight,
		watch : "window",
	});
	this.$('.event-small-title').dotdotdot({
		watch: "window",
	});
	this.$('.event-small-description').dotdotdot({
		watch: "window",
	});
};
